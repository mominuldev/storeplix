<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Tracking\Jobs\DeliverTrackingEvent;
use App\Domain\Tracking\Models\OrderTrackingContext;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D §5.3 / §5.4 / §6.2: creates server-event rows. One row per (integration, event_id, channel) — the insert is
 * `ON CONFLICT DO NOTHING`, so replays, double confirmations and races record (and send) once (S336). A row that can't
 * be sent is written `skipped` with its reason (no_token, no_consent, plan_required, disabled) and counted; a sendable
 * row is `pending` and its delivery job is dispatched after commit.
 */
final class TrackingRecorder
{
    /** §5.3: the order reached $triggers (order_placed | order_confirmed | order_delivered). @param list<string> $triggers */
    public static function purchase(Order $order, array $triggers): void
    {
        if ($order->created_via === Order::VIA_POS || $order->status === Order::CANCELLED) {
            return; // P89D-11: till sales are never sent; cancelled before the trigger → nothing
        }
        $integrations = TrackingIntegrations::active($order->store_id)
            ->filter(fn (StoreIntegration $i) => in_array($i->setting('purchase_trigger', 'order_confirmed'), $triggers, true)
                && in_array('purchase', TrackingEventNames::received($i), true));
        if ($integrations->isEmpty()) {
            return;
        }
        $context = OrderTrackingContext::query()->where('order_id', $order->id)->first();
        foreach ($integrations as $integration) {
            $skip = self::skipReason($integration, $context, true);
            self::insert($integration, 'purchase', 'purchase.'.$order->id, TrackingEvent::SERVER, 'order', [
                'order_id' => $order->id, 'value_amount' => null, 'currency' => $order->currency,
            ], $skip === null ? TrackingPayloads::purchase($integration, $order, $context) : null, $skip, function (array &$row, ?array $payload) {
                $row['value_amount'] = $payload['value_amount'] ?? null;
            });
        }
    }

    /** §5.4 (P89D-20): GA4 / GTM refund when the purchase was delivered to that integration. */
    public static function refund(Order $order, string $paymentId, int $amount): void
    {
        if ($order->created_via === Order::VIA_POS || $amount <= 0) {
            return;
        }
        $integrations = TrackingIntegrations::active($order->store_id)
            ->filter(fn (StoreIntegration $i) => in_array('refund', TrackingEventNames::received($i), true)
                && ($i->provider !== IntegrationProvider::GA4 || (bool) $i->setting('send_refunds', true)));
        if ($integrations->isEmpty()) {
            return;
        }
        $context = OrderTrackingContext::query()->where('order_id', $order->id)->first();
        foreach ($integrations as $integration) {
            $sent = TrackingEvent::query()->where('store_integration_id', $integration->id)->where('event_id', 'purchase.'.$order->id)
                ->where('channel', TrackingEvent::SERVER)->where('status', TrackingEvent::DELIVERED)->exists();
            if (! $sent) {
                continue;
            }
            $skip = self::skipReason($integration, $context, true);
            self::insert($integration, 'refund', 'refund.'.$paymentId, TrackingEvent::SERVER, 'refund', [
                'order_id' => $order->id, 'payment_id' => $paymentId, 'value_amount' => $amount, 'currency' => $order->currency,
            ], $skip === null ? TrackingPayloads::refund($integration, $order, $amount, $context) : null, $skip);
        }
    }

    /**
     * §6.2: the server copy of a browser event (P89D-10: Meta / TikTok when mirroring, GTM when selected; GA4 never).
     *
     * @param  array<string, mixed>  $payload
     */
    public static function mirror(StoreIntegration $integration, string $event, string $eventId, ?string $path, ?int $value, ?string $currency, array $payload, bool $test): void
    {
        $skip = self::skipReason($integration, null, false);
        if ($skip === 'no_consent') {
            return; // P89D-14: nothing is mirrored for a waiting integration until Accept
        }
        self::insert($integration, $event, $eventId, TrackingEvent::SERVER, 'browser_mirror', [
            'page_path' => $path, 'value_amount' => $value, 'currency' => $value !== null ? $currency : null, 'test' => $test,
        ], $skip === null ? $payload + ($test ? ['test' => true] : []) : null, $skip);
    }

    /** P89D-19: in test mode the browser's own event is logged too (for "Deduplicated"); never sent, never counted. */
    public static function browserTestRow(StoreIntegration $integration, string $event, string $eventId, ?string $path, ?int $value, ?string $currency): void
    {
        self::insert($integration, $event, $eventId, TrackingEvent::BROWSER, 'browser_mirror', [
            'page_path' => $path, 'value_amount' => $value, 'currency' => $value !== null ? $currency : null, 'test' => true,
            'status' => TrackingEvent::DELIVERED, 'delivered_at' => now(),
        ], null, null);
    }

    /** Why this integration can't receive a server event now (null = it can). */
    public static function skipReason(StoreIntegration $integration, ?OrderTrackingContext $context, bool $order): ?string
    {
        return match (true) {
            ! $integration->isActive() && ! in_array($integration->status, [StoreIntegration::ERROR], true) => 'disabled',
            ! TrackingIntegrations::planAllows($integration) => 'plan_required',
            ! TrackingIntegrations::hasToken($integration) => 'no_token',
            (bool) $integration->setting('wait_for_consent', false) && ($order ? $context?->consent !== 'granted' : false) => 'no_consent',
            default => null,
        };
    }

    /**
     * @param  array<string, mixed>  $columns
     * @param  array<string, mixed>|null  $payload
     * @param  (callable(array<string, mixed>&, array<string, mixed>|null): void)|null  $tweak
     */
    private static function insert(StoreIntegration $integration, string $event, string $eventId, string $channel, string $source, array $columns, ?array $payload, ?string $skip, ?callable $tweak = null): void
    {
        $now = now();
        $test = (bool) ($columns['test'] ?? false);
        $row = [
            'id' => strtolower((string) Str::ulid()),
            'tenant_id' => app(TenantContext::class)->requireId(),
            'store_id' => $integration->store_id,
            'store_integration_id' => $integration->id,
            'provider' => $integration->provider,
            'event_name' => $event,
            'provider_event_name' => TrackingEventNames::for($integration->provider, $event),
            'event_id' => mb_substr($eventId, 0, 64),
            'channel' => $channel,
            'source' => $source,
            'test' => $test,
            'order_id' => $columns['order_id'] ?? null,
            'payment_id' => $columns['payment_id'] ?? null,
            'page_path' => isset($columns['page_path']) ? mb_substr((string) $columns['page_path'], 0, 300) : null,
            'value_amount' => $columns['value_amount'] ?? null,
            'currency' => $columns['currency'] ?? null,
            'status' => $columns['status'] ?? ($skip !== null ? TrackingEvent::SKIPPED : TrackingEvent::PENDING),
            'skip_reason' => $skip,
            'attempts' => 0,
            'next_attempt_at' => $skip === null && ! isset($columns['status']) ? $now : null,
            'payload' => $skip === null && $payload !== null && ! isset($columns['status']) ? json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null,
            'delivered_at' => $columns['delivered_at'] ?? null,
            'created_at' => $now,
            'updated_at' => $now,
        ];
        if ($tweak !== null) {
            $tweak($row, $payload);
        }
        $inserted = DB::table('tracking_events')->insertOrIgnore($row);
        if ($inserted === 0) {
            return; // already recorded for this destination (S336)
        }
        if ($row['status'] === TrackingEvent::SKIPPED && ! $test) {
            TrackingStats::add($integration, $event, TrackingStats::SKIPPED);
        }
        if ($row['status'] === TrackingEvent::PENDING) {
            DeliverTrackingEvent::dispatch($row['id'])->forTenant($row['tenant_id'])->afterCommit();
        }
    }
}
