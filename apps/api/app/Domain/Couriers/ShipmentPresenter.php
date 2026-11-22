<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Shipping\Models\PickupLocation;

/** Shipment / ShipmentSummary / ShipmentDetail / ShipmentBatch (types §9, openapi 1.6.0). */
final class ShipmentPresenter
{
    /** @return array<string, mixed> Shipment (5a fields + 5b) */
    public static function shipment(Shipment $s): array
    {
        return [
            'id' => $s->id,
            'provider' => $s->provider,
            'carrier_name' => $s->carrier_name,
            'tracking_code' => $s->tracking_code,
            'tracking_url' => $s->tracking_url,
            'status' => $s->status,
            'cod_amount' => (int) $s->cod_amount,
            'shipped_at' => UserRef::iso($s->shipped_at),
            'delivered_at' => UserRef::iso($s->delivered_at),
            'returned_at' => UserRef::iso($s->returned_at),
            'consignment_id' => $s->consignment_id,
            'provider_status' => $s->provider_status,
            'attempts' => (int) ($s->attempts ?? 0),
            'problem' => $s->problem,
            'weight_grams' => $s->weight_grams,
            'delivery_fee_amount' => $s->delivery_fee_amount,
            'cod_charge_amount' => $s->cod_charge_amount,
            'cod_collected_amount' => $s->cod_collected_amount,
            'last_location' => $s->last_location,
            'last_event_at' => UserRef::iso($s->last_event_at),
            'booked_at' => UserRef::iso($s->booked_at),
            'picked_up_at' => UserRef::iso($s->picked_up_at),
            'cancelled_at' => UserRef::iso($s->cancelled_at),
            'failure_reason' => $s->failure_reason,
        ];
    }

    /** @return array<string, mixed> ShipmentSummary (expects the `order` relation, selected columns are enough) */
    public static function summary(Shipment $s): array
    {
        /** @var Order|null $o */
        $o = $s->relationLoaded('order') ? $s->order : $s->order()->first();
        $address = $o?->shipping_address ?? [];

        return self::shipment($s) + [
            'order' => [
                'id' => (string) $s->order_id,
                'number' => (string) ($o?->number ?? ''),
                'customer_name' => (string) ($o?->customer_name ?? ''),
                'customer_phone' => (string) ($o?->customer_phone ?? ''),
                'district' => (string) ($address['district'] ?? ''),
                'thana' => (string) ($address['thana'] ?? ''),
            ],
            'age_days' => self::ageDays($s),
        ];
    }

    /** @return array<string, mixed> ShipmentDetail */
    public static function detail(Shipment $s, ?CourierAccount $account, bool $canCancelApi): array
    {
        $events = ShipmentEvent::query()->where('shipment_id', $s->id)->orderByDesc('occurred_at')->orderByDesc('id')->get();
        $items = OrderItem::query()->where('order_id', $s->order_id)->orderBy('position')->get(['product_name', 'variant_title', 'quantity']);
        $pickup = $account?->pickup_location_id !== null
            ? PickupLocation::query()->whereKey($account->pickup_location_id)->first()
            : null;
        $collect = (int) $s->cod_amount;
        $net = $s->delivery_fee_amount === null ? null
            : (int) ($s->cod_collected_amount ?? $collect) - (int) $s->delivery_fee_amount - (int) ($s->cod_charge_amount ?? 0);
        $courier = $s->provider !== Shipment::MANUAL;
        $booked = $s->status === Shipment::BOOKED;

        return self::summary($s) + [
            'events' => $events->map(fn (ShipmentEvent $e) => $e->toContract())->values()->all(),
            'money' => [
                'collect_amount' => $collect,
                'delivery_fee_amount' => $s->delivery_fee_amount,
                'cod_charge_amount' => $s->cod_charge_amount,
                'net_amount' => $net,
            ],
            'parcel' => [
                'items_summary' => BookingService::describe('{items}', $items->all(), (string) ($s->order?->number ?? '')),
                'weight_grams' => $s->weight_grams,
                'pickup_location' => $pickup !== null ? (string) $pickup->name : null,
            ],
            'can' => [
                'cancel' => $courier && $booked && $canCancelApi,
                'mark_cancelled' => $courier && $booked,
                'refresh' => $courier && $s->consignment_id !== null && ! in_array($s->status, Shipment::FINAL_STATUSES, true),
            ],
        ];
    }

    /** @return array<string, mixed> ShipmentBatch */
    public static function batch(ShipmentBatch $b): array
    {
        return [
            'id' => $b->id,
            'provider' => $b->provider,
            'status' => $b->status,
            'total' => (int) $b->total,
            'booked' => (int) $b->booked,
            'skipped' => (int) $b->skipped,
            'failed' => (int) $b->failed,
            'results' => array_values(array_map(fn (array $r) => [
                'order_id' => (string) ($r['order_id'] ?? ''),
                'order_number' => (string) ($r['order_number'] ?? ''),
                'shipment_id' => $r['shipment_id'] ?? null,
                'status' => (string) ($r['status'] ?? 'failed'),
                'reason' => $r['reason'] ?? null,
            ], is_array($b->results) ? $b->results : [])),
            'created_at' => UserRef::iso($b->created_at),
            'finished_at' => UserRef::iso($b->finished_at),
        ];
    }

    /**
     * Storefront tracking additions (§11): normalised status and times ONLY — never descriptions, locations,
     * provider words or rider data. `events` newest first; `checked_at` = the later of the last poll and the last
     * webhook-delivered event.
     *
     * @return array{status: string, status_at: ?string, checked_at: ?string, events: list<array{status: string, at: ?string}>}
     */
    public static function tracking(Shipment $s): array
    {
        $events = ShipmentEvent::query()->where('shipment_id', $s->id)->orderByDesc('occurred_at')->orderByDesc('id')
            ->get(['id', 'status', 'source', 'occurred_at', 'created_at']);
        $webhookAt = $events->where('source', ShipmentEvent::WEBHOOK)->max('created_at');
        $checked = collect([$s->last_synced_at, $webhookAt])->filter()->max();
        $statusAt = $s->last_event_at ?? $s->delivered_at ?? $s->returned_at ?? $s->shipped_at ?? $s->booked_at;

        return [
            'status' => (string) $s->status,
            'status_at' => UserRef::iso($statusAt),
            'checked_at' => UserRef::iso($checked),
            'events' => $events->map(fn (ShipmentEvent $e) => ['status' => $e->status, 'at' => UserRef::iso($e->occurred_at)])->values()->all(),
        ];
    }

    public static function ageDays(Shipment $s): int
    {
        $start = $s->booked_at ?? $s->shipped_at ?? $s->created_at;
        if ($start === null) {
            return 0;
        }
        $end = $s->delivered_at ?? $s->returned_at ?? $s->cancelled_at ?? now();

        return max(0, (int) floor($start->diffInSeconds($end, true) / 86400));
    }
}
