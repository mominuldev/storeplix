<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Carbon;
use Throwable;

/**
 * PHASE-8-9D §6.2 (S335): browser events reported by the storefront beacon. Variants / products are resolved within the
 * store and priced from the catalogue — browser amounts are never accepted; unknown ids drop the event silently. Per
 * integration that receives the event and whose consent rule allows it: the browser count is incremented and a server
 * copy (same event_id) is queued where the provider mirrors (Meta / TikTok when on, GTM when selected; GA4 never). A
 * valid test-mode token also logs the browser row with `test: true`.
 */
final class TrackingBeacon
{
    /**
     * @param  list<array<string, mixed>>  $events  validated
     * @param  array<string, mixed>  $context  validated TrackingBrowserContext
     */
    public static function handle(Store $store, array $events, array $context, string $clientIp): void
    {
        $integrations = TrackingIntegrations::active($store->id)->filter(fn (StoreIntegration $i) => $i->isActive() && TrackingIntegrations::planAllows($i));
        if ($integrations->isEmpty()) {
            return;
        }
        $clean = TrackingContexts::sanitize($context);
        $consented = $clean['consent'] === 'granted';
        $testIntegration = TrackingTestMode::integrationFor(is_string($context['test_token'] ?? null) ? $context['test_token'] : null, $store->id);
        $client = array_filter([
            'ip' => filter_var($clientIp, FILTER_VALIDATE_IP) !== false ? $clientIp : null, 'ua' => $clean['user_agent'],
            'fbp' => $clean['fbp'], 'fbc' => $clean['fbc'], 'ttp' => $clean['ttp'], 'ttclid' => $clean['ttclid'],
            'ga_client_id' => $clean['ga_client_id'], 'ga_session_id' => $clean['ga_session_id'],
        ], fn ($v) => $v !== null);

        foreach ($events as $event) {
            $priced = self::price($store, $event);
            if ($priced === false) {
                continue; // unknown or foreign id: dropped
            }
            [$value, $items] = $priced;
            $time = self::time($event['occurred_at'] ?? null);
            $payload = TrackingPayloads::browser($store->id, (string) $event['page_path'], $client, $value, $store->currency, $items, $time)
                + ['client_id' => $client['ga_client_id'] ?? 'sp.'.$event['event_id']];
            foreach ($integrations as $integration) {
                $name = (string) $event['name'];
                if (! in_array($name, TrackingEventNames::received($integration), true)) {
                    continue;
                }
                if ((bool) $integration->setting('wait_for_consent', false) && ! $consented) {
                    continue; // P89D-14: the tag did not load, nothing is counted or mirrored
                }
                $test = $testIntegration === $integration->id;
                if (! $test) {
                    TrackingStats::add($integration, $name, TrackingStats::BROWSER);
                } else {
                    TrackingRecorder::browserTestRow($integration, $name, (string) $event['event_id'], (string) $event['page_path'], $value, $store->currency);
                }
                if (self::mirrors($integration)) {
                    TrackingRecorder::mirror($integration, $name, (string) $event['event_id'], (string) $event['page_path'], $value, $store->currency, $payload, $test);
                }
            }
        }
    }

    public static function mirrors(StoreIntegration $integration): bool
    {
        return match ($integration->provider) {
            IntegrationProvider::META_PIXEL, IntegrationProvider::TIKTOK_PIXEL => (bool) $integration->setting('mirror_browser_events', true),
            IntegrationProvider::GTM_SERVER => true,
            default => false, // GA4 never mirrors: MP does not deduplicate against gtag (P89D-10)
        };
    }

    /**
     * Catalogue price of view_item / add_to_cart (minor units); page_view / begin_checkout carry no value.
     *
     * @param  array<string, mixed>  $event
     * @return array{0: int|null, 1: list<array{id: string, name: string, quantity: int, price_amount: int}>}|false
     */
    private static function price(Store $store, array $event): array|false
    {
        $variantId = isset($event['variant_id']) ? strtolower((string) $event['variant_id']) : null;
        $productId = isset($event['product_id']) ? strtolower((string) $event['product_id']) : null;
        if (! in_array($event['name'], ['view_item', 'add_to_cart'], true) || ($variantId === null && $productId === null)) {
            return [null, []];
        }
        $query = ProductVariant::query()->with('product:id,name,status')->where('store_id', $store->id)->where('is_enabled', true);
        $variant = $variantId !== null
            ? $query->whereKey($variantId)->first()
            : $query->where('product_id', $productId)->orderByDesc('is_default')->orderBy('position')->first();
        if ($variant === null || $variant->product === null || $variant->product->status !== 'active'
            || ($productId !== null && $variant->product_id !== $productId)) {
            return false;
        }
        $quantity = $event['name'] === 'add_to_cart' ? max(1, min(999, (int) ($event['quantity'] ?? 1))) : 1;
        $name = $variant->product->name.(($variant->title ?? '') !== '' && $variant->title !== 'Default' ? ' - '.$variant->title : '');

        return [$variant->price_amount * $quantity, [['id' => $variant->id, 'name' => $name, 'quantity' => $quantity, 'price_amount' => (int) $variant->price_amount]]];
    }

    private static function time(mixed $value): int
    {
        try {
            $at = is_string($value) ? Carbon::parse($value) : now();
        } catch (Throwable) {
            $at = now();
        }
        // Providers refuse events from the future or older than 7 days: clamp to [now − 1 h, now].
        $now = now();

        return ($at->greaterThan($now) || $at->lessThan($now->copy()->subHour()) ? $now : $at)->getTimestamp();
    }
}
