<?php

namespace App\Domain\Orders;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Couriers\ShipmentPresenter;
use App\Domain\Customers\Models\Customer;
use App\Domain\Developer\ApiKeys\ApiKeyActors;
use App\Domain\FraudGuard\FraudGuardPresenter;
use App\Domain\FraudGuard\RiskTier;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Payments\GatewayCapabilities;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentPresenter;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Authorization\PermissionSet;

/** Order payloads (@storeplix/types): merchant OrderSummary / Order / OrderQuote lines, storefront order and tracking. */
final class OrderPresenter
{
    public const TIMESTAMPS = ['confirmed_at', 'shipped_at', 'delivered_at', 'returned_at', 'cancelled_at'];

    /** @return array<string, mixed> OrderSummary */
    public static function summary(Order $order, ?Customer $customer = null, ?int $itemsCount = null): array
    {
        $customer ??= $order->relationLoaded('customer') ? $order->customer : null;

        return [
            'id' => $order->id,
            'number' => $order->number,
            'status' => $order->status,
            'payment_status' => $order->payment_status,
            'payment_method' => $order->payment_method,
            'channel' => $order->channel,
            'created_via' => $order->created_via,
            'customer' => self::customerSummary($customer, $order),
            'district' => (string) ($order->shipping_address['district'] ?? ''),
            'thana' => (string) ($order->shipping_address['thana'] ?? ''),
            'items_count' => $itemsCount ?? (int) ($order->items_sum_quantity ?? $order->items()->sum('quantity')),
            'total_amount' => $order->total_amount,
            'paid_amount' => $order->paid_amount,
            'due_amount' => $order->dueAmount(),
            'currency' => $order->currency,
            'coupon_code' => $order->coupon_code,
            'tags' => array_values($order->tags ?? []),
            'placed_at' => UserRef::iso($order->placed_at),
            'updated_at' => UserRef::iso($order->updated_at),
            // 5b
            'return_status' => $order->return_status ?? 'none',
            'shipment' => self::shipmentRef($order),
            'invoice_printed_at' => UserRef::iso($order->invoice_printed_at),
            'label_printed_at' => UserRef::iso($order->label_printed_at),
            // PHASE-8-8 §6.5
            'guard' => FraudGuardPresenter::orderGuard($order, $order->relationLoaded('riskCheck') ? $order->riskCheck : $order->riskCheck()->first()),
            // PHASE-8-8D §8: the till sale behind a POS order ("POS · {register}" tag), else null
            'pos' => self::posRef($order),
        ];
    }

    /** @return array{sale_id: string, register_id: string, register_name: string}|null OrderPosRef */
    public static function posRef(Order $order): ?array
    {
        if (! $order->isPos()) {
            return null;
        }
        $sale = $order->relationLoaded('posSale') ? $order->posSale : $order->posSale()->with('register')->first();
        if ($sale === null) {
            return null;
        }

        return ['sale_id' => $sale->id, 'register_id' => $sale->register_id, 'register_name' => (string) $sale->register?->name];
    }

    /** @return array{provider: string, status: string, consignment_id: string|null}|null OrderSummary.shipment */
    private static function shipmentRef(Order $order): ?array
    {
        $shipment = $order->relationLoaded('shipment') ? $order->shipment : $order->shipment()->first();

        return $shipment === null ? null : [
            'provider' => $shipment->provider,
            'status' => $shipment->status,
            'consignment_id' => $shipment->getAttribute('consignment_id'),
        ];
    }

    /** @return array<string, mixed>|null OrderCustomerSummary (this shop only) */
    public static function customerSummary(?Customer $customer, ?Order $order): ?array
    {
        if ($customer === null && $order === null) {
            return null;
        }

        return [
            'id' => $customer?->id,
            'name' => $order?->customer_name ?? (string) $customer?->name,
            'phone' => $order?->customer_phone ?? (string) $customer?->phone,
            'email' => $order !== null ? $order->customer_email : $customer?->email,
            'orders_count' => (int) ($customer?->orders_count ?? 0),
            'delivered_orders_count' => (int) ($customer?->delivered_orders_count ?? 0),
            'returned_orders_count' => (int) ($customer?->returned_orders_count ?? 0),
            'total_spent_amount' => (int) ($customer?->total_spent_amount ?? 0),
            'risk' => RiskTier::payload($customer, $order?->store_id ?? $customer?->store_id), // PHASE-8-8 §6.5
        ];
    }

    /** @return array<string, mixed> Order */
    public static function full(Order $order, ?PermissionSet $permissions): array
    {
        $order->loadMissing(['items', 'customer', 'payments.actor', 'shipment', 'createdBy']);
        $costs = ($permissions?->has(Permission::CostsView) ?? false);
        $items = $order->items;
        $media = MediaMaps::load($items->pluck('image_media_id')->filter()->values()->all());
        $variants = ProductVariant::query()->where('store_id', $order->store_id)->whereIn('id', $items->pluck('variant_id')->filter()->all())
            ->with('inventory')->get()->keyBy('id');
        $events = OrderEvent::query()->where('order_id', $order->id)->with('actor')
            ->orderByDesc('created_at')->orderByDesc('id')->limit(200)->get();
        $allowed = OrderStateMachine::allowedFor($order, $permissions);
        $timestamps = [];
        foreach (self::TIMESTAMPS as $column) {
            if ($order->{$column} !== null) {
                $timestamps[$column] = UserRef::iso($order->{$column});
            }
        }

        $summary = self::summary($order, $order->customer, (int) $items->sum('quantity'));
        unset($summary['shipment']); // Order.shipment is the full Shipment (a superset of OrderSummary.shipment)

        return $summary + [
            'contact' => ['name' => $order->customer_name, 'phone' => $order->customer_phone, 'email' => $order->customer_email],
            'shipping_address' => self::address($order->shipping_address),
            'customer_note' => $order->customer_note,
            'items' => $items->map(fn (OrderItem $item) => self::item($item, $media, $variants[$item->variant_id] ?? null, $costs))->values()->all(),
            'events' => $events->map(fn (OrderEvent $e) => self::event($e))->all(),
            'payments' => $order->payments->map(fn (Payment $p) => self::payment($p, $permissions))->values()->all(),
            'shipment' => $order->shipment ? self::shipment($order->shipment) : null,
            'subtotal_amount' => $order->subtotal_amount,
            'discount_amount' => $order->discount_amount,
            'shipping_amount' => $order->shipping_amount,
            'shipping_discount_amount' => $order->shipping_discount_amount,
            'tax_amount' => $order->tax_amount,
            'refunded_amount' => $order->refunded_amount,
            'shipping_zone_name' => $order->shipping_zone_name,
            'delivery_min_days' => $order->delivery_min_days,
            'delivery_max_days' => $order->delivery_max_days,
            'shipping_overridden' => $order->shipping_overridden,
            'cancel_reason' => $order->cancel_reason,
            'timestamps' => (object) $timestamps,
            'allowed_transitions' => $allowed,
            'can' => [
                'edit' => in_array($order->status, Order::EDITABLE, true),
                'cancel' => in_array(Order::CANCELLED, $allowed, true),
                'refund' => ($permissions?->has(Permission::OrdersRefund) ?? false) && $order->paid_amount - $order->refunded_amount > 0,
            ],
            'revision' => $order->revision,
            'created_by' => UserRef::of($order->createdBy),
            // 5b
            'shipments' => $order->shipments()->get()->map(fn (Shipment $sh) => self::shipment($sh))->values()->all(),
            'payment_links' => self::paymentLinks($order),
            'payment_expires_at' => UserRef::iso($order->payment_expires_at),
            'source_order_id' => $order->source_order_id,
        ];
    }

    /**
     * @param  array<string, Media>  $media
     * @return array<string, mixed> OrderItem
     */
    public static function item(OrderItem $item, array $media, ?ProductVariant $variant, bool $costs): array
    {
        return [
            'id' => $item->id,
            'product_id' => $item->product_id,
            'variant_id' => $item->variant_id,
            'product_name' => $item->product_name,
            'variant_title' => $item->variant_title,
            'option_values' => array_values($item->option_values ?? []),
            'sku' => $item->sku,
            'image' => MediaPresenter::ref($item->image_media_id ? ($media[$item->image_media_id] ?? null) : null),
            'unit_price_amount' => $item->unit_price_amount,
            'compare_at_amount' => $item->compare_at_amount,
            'unit_cost_amount' => $costs ? $item->unit_cost_amount : null,
            'quantity' => $item->quantity,
            'subtotal_amount' => $item->subtotal_amount,
            'discount_amount' => $item->discount_amount,
            'total_amount' => $item->total_amount,
            'restocked_quantity' => $item->restocked_quantity,
            'current_stock' => self::stock($variant),
        ];
    }

    /** @return array{available: int, tracked: bool}|null */
    public static function stock(?ProductVariant $variant): ?array
    {
        if ($variant === null || $variant->trashed()) {
            return null;
        }
        /** @var Inventory|null $inventory */
        $inventory = $variant->inventory;

        return ['available' => $inventory ? $inventory->on_hand - $inventory->committed : 0, 'tracked' => $variant->track_inventory];
    }

    /**
     * OrderQuote line: OrderItem minus id / restocked_quantity, plus issue.
     *
     * @param  array<string, mixed>  $input  LineLoader line
     * @param  array<string, mixed>  $line  CartPricer line
     * @return array<string, mixed>
     */
    public static function quoteLine(?ProductVariant $variant, array $input, array $line, bool $costs): array
    {
        $product = $variant?->product;
        $mediaId = $variant?->image_media_id ?? $product?->images->first()?->media_id;
        $media = $mediaId ? MediaMaps::load([$mediaId]) : [];

        return [
            'product_id' => $product?->id,
            'variant_id' => $input['variant_id'],
            'product_name' => (string) $product?->name,
            'variant_title' => (string) $variant?->title,
            'option_values' => $variant && $product ? $variant->optionValues(count($product->options ?? [])) : [],
            'sku' => $variant?->sku,
            'image' => MediaPresenter::ref($mediaId ? ($media[$mediaId] ?? null) : null),
            'unit_price_amount' => $line['unit_price_amount'],
            'compare_at_amount' => $line['compare_at_amount'],
            'unit_cost_amount' => $costs ? $variant?->cost_amount : null,
            'quantity' => $input['quantity'],
            'subtotal_amount' => $line['line_amount'],
            'discount_amount' => $line['discount_amount'],
            'total_amount' => $line['line_amount'] - $line['discount_amount'],
            'current_stock' => self::stock($variant),
            'issue' => $line['issue'],
        ];
    }

    /** @return array<string, mixed> */
    public static function event(OrderEvent $event): array
    {
        return [
            'id' => $event->id,
            'type' => $event->type,
            'from_status' => $event->from_status,
            'to_status' => $event->to_status,
            'actor' => $event->actor_type === 'api_key' && $event->actor_api_key_id !== null
                ? ['user' => null] + ApiKeyActors::ref($event->actor_api_key_id) // PHASE-8-4 §3
                : ['type' => $event->actor_type, 'user' => UserRef::of($event->actor)],
            'body' => $event->body,
            'meta' => (object) ($event->meta ?? []),
            'created_at' => UserRef::iso($event->created_at),
        ];
    }

    /** @return list<array<string, mixed>> PaymentLink[] (newest first) */
    public static function paymentLinks(Order $order): array
    {
        $links = PaymentLink::query()->where('order_id', $order->id)->with('creator')->orderByDesc('created_at')->orderByDesc('id')->get();
        if ($links->isEmpty()) {
            return [];
        }
        $store = Store::query()->with('primaryDomain')->findOrFail($order->store_id);

        return $links->map(fn (PaymentLink $l) => PaymentPresenter::link($l, $store))->values()->all();
    }

    /** @return array<string, mixed> Payment */
    public static function payment(Payment $payment, ?PermissionSet $permissions = null): array
    {
        return [
            'id' => $payment->id,
            'provider' => $payment->provider,
            'type' => $payment->type,
            'status' => $payment->status,
            'amount' => $payment->amount,
            'currency' => $payment->currency,
            'method' => $payment->method,
            'reference' => $payment->reference,
            'note' => $payment->note,
            'actor' => UserRef::of($payment->actor),
            'created_at' => UserRef::iso($payment->created_at),
            // 5b
            'purpose' => $payment->purpose ?? Payment::PURPOSE_ORDER,
            'provider_trx_id' => $payment->provider_trx_id,
            'refunded_amount' => (int) ($payment->refunded_amount ?? 0),
            'expires_at' => UserRef::iso($payment->expires_at),
            'failure_code' => $payment->failure_code,
            'payment_link_id' => $payment->payment_link_id,
            'return_request_id' => $payment->return_request_id ?? null,
            'can_refund' => $payment->type === Payment::TYPE_CHARGE && $payment->isOnline() && $payment->status === Payment::STATUS_SUCCEEDED
                && GatewayCapabilities::supportsRefund($payment->provider) // PHASE-8-9D P89D-48 (Nagad: refund in the portal)
                && ($permissions?->has(Permission::OrdersRefund) ?? false) && (int) $payment->amount - (int) $payment->refunded_amount > 0,
            'pos_session_id' => $payment->pos_session_id ?? null, // PHASE-8-8D §6.3: the till session ("Till · Register 1"), else null
        ];
    }

    /** @return array<string, mixed> Shipment (5a fields + 5b courier fields; 5b-3 ShipmentPresenter) */
    public static function shipment(Shipment $shipment): array
    {
        return ShipmentPresenter::shipment($shipment);
    }

    /** @param array<string, mixed> $a @return array<string, mixed> Address */
    public static function address(array $a): array
    {
        return [
            'division_code' => (string) ($a['division_code'] ?? ''),
            'division' => (string) ($a['division'] ?? ''),
            'district_code' => (string) ($a['district_code'] ?? ''),
            'district' => (string) ($a['district'] ?? ''),
            'thana_code' => (string) ($a['thana_code'] ?? ''),
            'thana' => (string) ($a['thana'] ?? ''),
            'area' => $a['area'] ?? null,
            'address_line' => (string) ($a['address_line'] ?? ''),
            'landmark' => $a['landmark'] ?? null,
            'label' => $a['label'] ?? null,
        ];
    }

    // ---------------- Storefront (no cost, SKU, stock, ids, internal notes) ----------------

    /** @return list<array<string, mixed>> StorefrontOrderLine[] */
    public static function storefrontLines(Order $order): array
    {
        $items = $order->relationLoaded('items') ? $order->items : $order->items()->get();
        $media = MediaMaps::load($items->pluck('image_media_id')->filter()->values()->all());

        return $items->map(function (OrderItem $item) use ($media) {
            $m = $item->image_media_id ? ($media[$item->image_media_id] ?? null) : null;

            return [
                'product_name' => $item->product_name,
                'variant_title' => $item->variant_title,
                'quantity' => $item->quantity,
                'image' => $m !== null && $m->status !== Media::FAILED ? array_merge(MediaMaps::storefrontMedia($m), ['alt' => $m->alt ?? $item->product_name]) : null,
                'unit_price_amount' => $item->unit_price_amount,
                'total_amount' => $item->total_amount,
            ];
        })->values()->all();
    }

    /** @return array<string, mixed> StorefrontOrder */
    public static function storefront(Order $order): array
    {
        return [
            'number' => $order->number,
            'status' => $order->status,
            'payment_method' => $order->payment_method,
            'placed_at' => UserRef::iso($order->placed_at),
            'customer_name' => $order->customer_name,
            'customer_phone' => $order->customer_phone,
            'shipping_address' => self::address($order->shipping_address),
            'lines' => self::storefrontLines($order),
            'coupon_code' => $order->coupon_code,
            'subtotal_amount' => $order->subtotal_amount,
            'discount_amount' => $order->discount_amount,
            'shipping_amount' => $order->shipping_amount,
            'total_amount' => $order->total_amount,
            'due_amount' => $order->dueAmount(),
            'currency' => $order->currency,
            'delivery' => ['zone_name' => $order->shipping_zone_name, 'min_days' => $order->delivery_min_days, 'max_days' => $order->delivery_max_days],
            // 5b
            'payment' => PaymentPresenter::storefrontState($order),
            'paid_amount' => $order->paid_amount,
        ];
    }

    /** @return array<string, mixed> StorefrontOrderTracking (district and thana only; no street, email or phone) */
    public static function tracking(Order $order): array
    {
        $timeline = [['status' => Order::PENDING, 'at' => UserRef::iso($order->placed_at)]];
        $events = OrderEvent::query()->where('order_id', $order->id)->where('type', 'status_changed')->orderBy('created_at')->orderBy('id')->get();
        foreach ($events as $event) {
            $timeline[] = ['status' => $event->to_status, 'at' => UserRef::iso($event->created_at)];
        }
        // The active shipment: newest, not cancelled / booking_failed (PHASE-5B §4.7).
        $shipment = Shipment::query()->where('order_id', $order->id)->whereNotIn('status', ['cancelled', 'booking_failed'])
            ->orderByDesc('created_at')->orderByDesc('id')->first();

        return [
            'number' => $order->number,
            'status' => $order->status,
            'placed_at' => UserRef::iso($order->placed_at),
            'shipping' => ['district' => (string) ($order->shipping_address['district'] ?? ''), 'thana' => (string) ($order->shipping_address['thana'] ?? '')],
            'lines' => self::storefrontLines($order),
            'total_amount' => $order->total_amount,
            'due_amount' => $order->dueAmount(),
            'currency' => $order->currency,
            'timeline' => $timeline,
            'shipment' => $shipment ? [
                'carrier_name' => $shipment->carrier_name,
                'tracking_code' => $shipment->tracking_code,
                'tracking_url' => $shipment->tracking_url,
            ] + ShipmentPresenter::tracking($shipment) : null,
        ];
    }
}
