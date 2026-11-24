<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Inventory\InventoryService;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\OrderStateMachine;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Returns\ReturnService;
use Illuminate\Support\Facades\DB;

/**
 * Order effects of a courier shipment status change (PHASE-5B P5B-36, §6.4, §8). Called by ShipmentSync with the
 * order and the shipment rows locked (lock order: order → shipment → inventories → payments), after the shipment's new
 * status is decided. Never moves an order backwards: every effect checks the order's current state first, so a replay
 * or an out-of-order event is a no-op.
 *
 *  - picked_up / in_transit / out_for_delivery (and anything later, when the pickup signal was missed) → order
 *    `shipped` via InventoryService::ship (stock leaves on_hand), once;
 *  - delivered → order `delivered`; the pending COD charge `succeeded` with amount = cod_collected (re-queried by the
 *    caller); paid/payment_status; customer counters as 5a;
 *  - partially_delivered → as delivered with paid = what was collected, and a courier-sourced return in `requested`;
 *  - returned → order `returned`, no automatic restock (P5B-69 restocks), pending COD charge `cancelled`;
 *  - cancelled (before pickup) / booking_failed → the order stays where it is (`ready_to_ship` after a booking).
 */
class ShipmentStatusApplier
{
    /** Statuses that prove the parcel left the shop. */
    public const AFTER_PICKUP = ['picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'delivery_failed', 'returning', 'delivered', 'partially_delivered', 'returned'];

    public function __construct(
        private readonly InventoryService $inventory,
        private readonly ReturnService $returns,
    ) {}

    /**
     * @param  Order  $order  locked
     * @param  Shipment  $shipment  locked, already carrying the new status
     * @return array{shipped: bool, order_status: string} `shipped` = the order moved to shipped now (SMS after commit)
     */
    public function apply(Order $order, Shipment $shipment, string $from, string $to): array
    {
        $shipped = false;
        if (in_array($to, self::AFTER_PICKUP, true) && in_array($order->status, [Order::CONFIRMED, Order::READY_TO_SHIP], true)) {
            $this->ship($order, $shipment);
            $shipped = true;
        }

        if (($to === 'delivered' || $to === 'partially_delivered') && $order->status === Order::SHIPPED) {
            $this->deliver($order, $shipment, $to === 'partially_delivered');
        } elseif ($to === 'returned' && $order->status === Order::SHIPPED) {
            $this->returned($order, $shipment);
        }

        return ['shipped' => $shipped, 'order_status' => $order->status];
    }

    private function ship(Order $o, Shipment $s): void
    {
        $from = $o->status;
        OrderStateMachine::assert($from, Order::SHIPPED);
        $lines = [];
        foreach (OrderItem::query()->where('order_id', $o->id)->orderBy('position')->get() as $i => $item) {
            if ($item->tracked && $item->variant_id !== null) {
                $lines[] = ['variant_id' => $item->variant_id, 'quantity' => $item->quantity, 'field' => "items.{$i}.quantity"];
            }
        }
        $this->inventory->ship($o->store_id, $lines, $o->id, null);
        $now = now();
        $o->shipped_at ??= $now;
        $s->shipped_at ??= $now;
        $this->move($o, Order::SHIPPED, [
            'carrier_name' => $s->carrier_name,
            'tracking_code' => $s->tracking_code,
            'tracking_url' => $s->tracking_url,
            'provider' => $s->provider,
            'shipment_id' => $s->id,
        ]);
    }

    private function deliver(Order $o, Shipment $s, bool $partial): void
    {
        $now = now();
        // P5B-36: cod_collected comes from the courier's status API (re-queried for webhooks); a full delivery that
        // didn't report it collected what we asked for.
        $collected = $s->cod_collected_amount ?? ($partial ? 0 : (int) $s->cod_amount);
        $collected = max(0, min((int) $collected, $o->dueAmount()));
        $s->cod_collected_amount = $collected;

        $charge = Payment::query()->where('order_id', $o->id)->where('provider', Payment::PROVIDER_COD)->where('type', Payment::TYPE_CHARGE)
            ->where('status', Payment::STATUS_PENDING)->lockForUpdate()->first();
        if ($charge !== null) {
            $charge->forceFill($collected > 0
                ? ['status' => Payment::STATUS_SUCCEEDED, 'amount' => $collected, 'verified_at' => $now]
                : ['status' => Payment::STATUS_CANCELLED])->save();
        }
        if ($collected > 0) {
            $o->paid_amount = min($o->total_amount, $o->paid_amount + $collected);
        }
        $o->payment_status = match (true) {
            $o->refunded_amount > 0 => $o->refunded_amount >= $o->paid_amount && $o->paid_amount > 0 ? 'refunded' : 'partially_refunded',
            $o->total_amount > 0 && $o->paid_amount >= $o->total_amount => 'paid',
            $o->paid_amount > 0 => 'partially_paid',
            $o->total_amount === 0 => 'paid',
            default => 'unpaid',
        };
        WebhookEvents::orderPaidIfChanged($o);
        $o->delivered_at = $now;
        $s->delivered_at ??= $now;
        if ($o->customer_id !== null) {
            Customer::withTrashed()->whereKey($o->customer_id)->update([
                'delivered_orders_count' => DB::raw('delivered_orders_count + 1'),
                'total_spent_amount' => DB::raw('total_spent_amount + '.($partial ? (int) $o->paid_amount : (int) $o->total_amount)),
            ]);
        }
        $this->move($o, Order::DELIVERED, ['shipment_id' => $s->id, 'provider' => $s->provider, 'cod_collected_amount' => $collected, 'partial' => $partial]);

        if ($partial) {
            // §8: a return in `requested`, source courier, no lines (the merchant adds them on receive).
            $o->save();
            $this->returns->createForCourier($o);
            $o->refresh();
        }
    }

    private function returned(Order $o, Shipment $s): void
    {
        $now = now();
        Payment::query()->where('order_id', $o->id)->where('provider', Payment::PROVIDER_COD)->where('type', Payment::TYPE_CHARGE)
            ->where('status', Payment::STATUS_PENDING)->update(['status' => Payment::STATUS_CANCELLED, 'updated_at' => $now]);
        $o->returned_at = $now;
        $s->returned_at ??= $now;
        if ($o->customer_id !== null) {
            Customer::withTrashed()->whereKey($o->customer_id)->update(['returned_orders_count' => DB::raw('returned_orders_count + 1')]);
        }
        // No automatic restock (P5B-36): the dashboard shows "Parcel back — restock" (POST /orders/{order}/restock).
        $this->move($o, Order::RETURNED, ['shipment_id' => $s->id, 'provider' => $s->provider, 'restock_pending' => true]);
    }

    /** @param array<string, mixed> $meta */
    private function move(Order $o, string $to, array $meta): void
    {
        $from = $o->status;
        OrderStateMachine::assert($from, $to);
        $o->status = $to;
        $o->revision++;
        $o->save();
        OrderTimeline::record($o, 'status_changed', null, null, array_filter($meta, fn ($v) => $v !== null), $from, $to, 'system');
    }
}
