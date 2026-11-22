<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Drivers\StatusUpdate;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Orders\OrderTimeline;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * The one effect path for courier status reports — webhooks, polls, manual refresh and the fake-advance tool
 * (PHASE-5B §6.4, P5B-36/37/38, ADR 0013):
 * lock order → lock shipment → dedupe on (provider_status, occurred_at) → append shipment_events → update the
 * shipment → order effect when the normalised status changed (ShipmentStatusApplier) → order timeline → after commit:
 * SMS `order_shipped` on the move to `shipped`.
 *
 * Status moves are monotonic (`canMove`): a final status is never left, nothing goes back to `booked`, and the
 * in-flight statuses (in_transit, out_for_delivery, on_hold, delivery_failed) only replace each other with a newer
 * event. Unknown courier words keep the status and flag `problem: unknown`.
 */
class ShipmentSync
{
    public const FINAL = ['delivered', 'partially_delivered', 'returned', 'cancelled', 'booking_failed'];

    public const ACTIVE = ['booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'delivery_failed', 'returning'];

    /** Monotonic rank; equal ranks ≥ 3 may replace each other when the event is newer. */
    private const RANK = [
        'booking' => 0, 'booked' => 1, 'picked_up' => 2,
        'in_transit' => 3, 'out_for_delivery' => 3, 'on_hold' => 3, 'delivery_failed' => 3,
        'returning' => 5, 'delivered' => 6, 'partially_delivered' => 6, 'returned' => 7,
    ];

    private const PROBLEM_STATUSES = ['delivery_failed' => 'delivery_failed', 'on_hold' => 'on_hold', 'returning' => 'returning'];

    public function __construct(
        private readonly CourierManager $couriers,
        private readonly ShipmentStatusApplier $effects,
        private readonly OrderNotifier $notifier,
    ) {}

    /** Courier poll / manual refresh: ask the courier, then apply. @throws CourierException */
    public function refresh(Shipment $shipment, string $source = 'poll'): Shipment
    {
        $account = $this->account($shipment);
        $update = $this->couriers->driver($shipment->provider)->status($shipment, $account);

        return $this->apply($shipment, $update, $source);
    }

    /**
     * Webhook path (P5B-37, S32): money-relevant statuses are re-queried from the courier status API and the API's
     * answer is applied instead of the payload's.
     *
     * @throws CourierException when the re-query fails (the job retries)
     */
    public function applyWebhook(Shipment $shipment, StatusUpdate $update): Shipment
    {
        $driver = $this->couriers->driver($shipment->provider);
        // Webhooks are parsed without the shipment; some words depend on it (Steadfast `pending` after `in_review`
        // = picked up, `cancelled` after pickup = returning, §6.1).
        $n = $driver->normalise($update->providerStatus, $shipment);
        if ($n->status !== null && $n->status !== $update->status) {
            $update = new StatusUpdate($n->status, $update->providerStatus, $update->occurredAt, $update->description, $update->location,
                $update->codCollectedAmount, $n->problem, $update->settled || $n->settled, $update->raw);
        }
        if ($update->isMoneyRelevant()) {
            $update = $driver->status($shipment, $this->account($shipment));
        }

        return $this->apply($shipment, $update, 'webhook');
    }

    /** @param 'webhook'|'poll'|'user'|'system' $source */
    public function apply(Shipment $shipment, StatusUpdate $update, string $source): Shipment
    {
        $notify = null;
        $result = DB::transaction(function () use ($shipment, $update, $source, &$notify) {
            /** @var Order $order */
            $order = Order::query()->whereKey($shipment->order_id)->lockForUpdate()->firstOrFail();
            /** @var Shipment $s */
            $s = Shipment::query()->whereKey($shipment->id)->lockForUpdate()->firstOrFail();
            $now = now();
            $occurred = $update->occurredAt;
            $providerStatus = mb_substr($update->providerStatus, 0, 48);
            if ($source === 'poll' || $source === 'user') {
                $s->last_synced_at = $now;
            }

            // Dedupe: the same courier report (word + time) is applied once, whatever path it came through.
            $duplicate = ShipmentEvent::query()->where('shipment_id', $s->id)->where('provider_status', $providerStatus)
                ->where('occurred_at', $occurred)->exists();
            $from = (string) $s->status;
            $to = $update->status;
            $newer = $s->last_event_at === null || $occurred->greaterThanOrEqualTo($s->last_event_at);
            $moves = $to !== null && ! $duplicate && self::canMove($from, $to, $newer);
            $settles = $update->settled && $s->settled_at === null;
            // A poll that repeats the current word adds nothing to the timeline.
            $repeat = $providerStatus === (string) $s->provider_status && ! $moves && ! $settles
                && ($update->problem ?? null) === $s->problem;
            if ($duplicate || $repeat) {
                $s->save();

                return $s;
            }

            $event = new ShipmentEvent;
            $event->forceFill([
                'store_id' => $s->store_id,
                'shipment_id' => $s->id,
                'status' => $moves ? $to : $from,
                'provider_status' => $providerStatus,
                'description' => $update->description !== null ? mb_substr($update->description, 0, 255)
                    : ($to === null && $update->problem === 'unknown' ? 'Courier problem · needs you' : null),
                'location' => $update->location !== null ? mb_substr($update->location, 0, 120) : null,
                'source' => $source,
                'occurred_at' => $occurred,
            ]);
            $event->save();

            if ($newer || $moves) {
                $s->last_event_at = $newer ? $occurred : $s->last_event_at;
                $s->provider_status = $providerStatus;
                if ($update->location !== null) {
                    $s->last_location = mb_substr($update->location, 0, 120);
                }
            }
            if ($settles) {
                $s->settled_at = $occurred;
            }
            if ($to === null) {
                // Unknown word (or an info-only event): status unchanged; flag it when the driver says so.
                if ($update->problem !== null && ! in_array($from, self::FINAL, true)) {
                    $s->problem = $update->problem;
                }
                $s->save();

                return $s;
            }
            if (! $moves) {
                $s->save();

                return $s;
            }

            if ($update->codCollectedAmount !== null && in_array($to, ['delivered', 'partially_delivered'], true)) {
                $s->cod_collected_amount = max(0, $update->codCollectedAmount);
            }
            $s->status = $to;
            $s->problem = self::PROBLEM_STATUSES[$to] ?? ($update->problem !== 'unknown' ? $update->problem : null);
            if (in_array($to, ShipmentStatusApplier::AFTER_PICKUP, true)) {
                $s->picked_up_at ??= $occurred;
            }
            if ($to === 'cancelled') {
                $s->cancelled_at ??= $now;
            }
            if ($to === 'returned') {
                $s->returned_at ??= $now;
            }

            $outcome = $this->effects->apply($order, $s, $from, $to);
            $s->save();
            OrderTimeline::record($order, 'shipment', null, null, [
                'shipment_id' => $s->id, 'provider' => $s->provider, 'from' => $from, 'to' => $to, 'provider_status' => $providerStatus, 'source' => $source,
            ], actorType: 'system');
            if ($outcome['shipped']) {
                $notify = [$order, $s->carrier_name ?? ucfirst((string) $s->provider)];
            }

            return $s;
        });
        if ($notify !== null) {
            $this->notifier->sms($notify[0], 'order_shipped', null, $notify[1]);
        }

        return $result;
    }

    /**
     * Monotonic status rule (P5B-36): finals are never left; `cancelled` only before pickup; `booked` only from
     * `booking`; in-flight statuses replace each other only with a newer event; otherwise the rank must grow.
     */
    public static function canMove(string $from, string $to, bool $newer = true): bool
    {
        if ($from === $to || in_array($from, self::FINAL, true) || $to === 'booking' || $to === 'booking_failed' || $to === 'shipped') {
            return false;
        }
        if ($to === 'cancelled') {
            return in_array($from, ['booking', 'booked'], true);
        }
        $a = self::RANK[$from] ?? null;
        $b = self::RANK[$to] ?? null;
        if ($a === null || $b === null) {
            return false;
        }
        if ($b > $a) {
            return true;
        }

        return $b === $a && $a === 3 && $newer;
    }

    public function account(Shipment $shipment): CourierAccount
    {
        $account = $shipment->courier_account_id !== null
            ? CourierAccount::query()->whereKey($shipment->courier_account_id)->first()
            : CourierAccount::query()->where('store_id', $shipment->store_id)->where('provider', $shipment->provider)->first();

        return $account ?? throw new CourierException(CourierException::NOT_CONNECTED, 'The courier account is not connected.');
    }

    public static function at(?string $iso): CarbonImmutable
    {
        return $iso !== null ? CarbonImmutable::parse($iso) : CarbonImmutable::now();
    }
}
