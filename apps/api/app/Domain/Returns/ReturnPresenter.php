<?php

namespace App\Domain\Returns;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Returns\Models\ReturnEvent;
use App\Domain\Returns\Models\ReturnItem;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shared\Http\UserRef;

/** ReturnSummary / ReturnRequest / ReturnEvent payloads (@storeplix/types, PHASE-5B §9). */
final class ReturnPresenter
{
    /** Relations a list page needs (no N+1). */
    public const WITH = ['order', 'items.orderItem'];

    /**
     * @param  array<string, string>  $couriers  order_id => shipment provider
     * @return array<string, mixed>
     */
    public static function summary(ReturnRequest $r, array $couriers = []): array
    {
        $r->loadMissing(self::WITH);

        return [
            'id' => $r->id,
            'number' => $r->number,
            'type' => $r->type,
            'status' => $r->status,
            'reason' => $r->reason,
            'source' => $r->source,
            'order' => ['id' => $r->order_id, 'number' => (string) $r->order?->number],
            'customer' => ['name' => (string) $r->order?->customer_name, 'phone' => (string) $r->order?->customer_phone],
            'items_preview' => $r->items->map(fn (ReturnItem $i) => [
                'product_name' => (string) $i->orderItem?->product_name,
                'variant_title' => (string) $i->orderItem?->variant_title,
                'quantity' => $i->quantity,
            ])->values()->all(),
            'requested_amount' => $r->requested_amount,
            'refunded_amount' => $r->refunded_amount,
            'courier' => $couriers[$r->order_id] ?? null,
            'created_at' => UserRef::iso($r->created_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function full(ReturnRequest $r): array
    {
        $r->loadMissing([...self::WITH, 'exchangeOrder']);
        $courier = Shipment::query()->where('order_id', $r->order_id)->where('status', '<>', 'cancelled')->orderByDesc('created_at')->value('provider');
        $items = $r->items;
        $media = MediaMaps::load($items->map(fn (ReturnItem $i) => $i->orderItem?->image_media_id)->filter()->values()->all());
        $variantIds = $items->pluck('exchange_variant_id')->filter()->unique()->values()->all();
        $variants = $variantIds === [] ? collect() : ProductVariant::withTrashed()->where('store_id', $r->store_id)->whereIn('id', $variantIds)->with('inventory')->get()->keyBy('id');
        $events = ReturnEvent::query()->where('return_request_id', $r->id)->with('actor')->orderByDesc('created_at')->orderByDesc('id')->limit(200)->get();

        $exchangeValue = 0;
        foreach ($items as $i) {
            $v = $i->exchange_variant_id ? ($variants[$i->exchange_variant_id] ?? null) : null;
            $exchangeValue += $v ? (int) $v->price_amount * $i->quantity : 0;
        }
        $difference = null;
        if ($r->type === 'exchange') {
            $difference = $r->exchangeOrder !== null
                ? $r->exchangeOrder->subtotal_amount + $r->exchangeOrder->shipping_amount - $r->requested_amount
                : $exchangeValue - $r->requested_amount; // estimate before the order exists (delivery not included)
        }

        return self::summary($r, $courier ? [$r->order_id => $courier] : []) + [
            'customer_note' => $r->customer_note,
            'pickup_tracking_code' => $r->pickup_tracking_code,
            'checks' => self::checks($r->checks ?? []),
            'items' => $items->map(function (ReturnItem $i) use ($media, $variants) {
                /** @var OrderItem|null $oi */
                $oi = $i->orderItem;
                /** @var ProductVariant|null $v */
                $v = $i->exchange_variant_id ? ($variants[$i->exchange_variant_id] ?? null) : null;
                $inventory = $v?->inventory;

                return [
                    'id' => $i->id,
                    'order_item_id' => $i->order_item_id,
                    'product_name' => (string) $oi?->product_name,
                    'variant_title' => (string) $oi?->variant_title,
                    'image' => MediaPresenter::ref($oi?->image_media_id ? ($media[$oi->image_media_id] ?? null) : null),
                    'quantity' => $i->quantity,
                    'amount' => $i->amount,
                    'restocked_quantity' => $i->restocked_quantity,
                    'exchange_variant' => $i->exchange_variant_id === null ? null : [
                        'id' => $i->exchange_variant_id,
                        'title' => (string) ($i->exchange_variant_title ?? $v?->title),
                        'price_amount' => (int) ($v?->price_amount ?? 0),
                        'available' => $v !== null && $v->track_inventory && ! $v->trashed() ? ($inventory ? $inventory->on_hand - $inventory->committed : 0) : null,
                    ],
                ];
            })->values()->all(),
            'events' => $events->map(fn (ReturnEvent $e) => self::event($e))->all(),
            'exchange_order' => $r->exchangeOrder ? ['id' => $r->exchangeOrder->id, 'number' => $r->exchangeOrder->number] : null,
            'price_difference_amount' => $difference,
            'allowed_transitions' => ReturnStateMachine::allowed($r),
            'revision' => $r->revision,
        ];
    }

    /** @return array<string, mixed> */
    public static function event(ReturnEvent $e): array
    {
        return [
            'id' => $e->id,
            'type' => $e->type,
            'from_status' => $e->from_status,
            'to_status' => $e->to_status,
            'actor' => ['type' => $e->actor_type, 'user' => UserRef::of($e->actor)],
            'body' => $e->body,
            'meta' => (object) ($e->meta ?? []),
            'created_at' => UserRef::iso($e->created_at),
        ];
    }

    /**
     * Fixed key order on every database: Postgres jsonb reorders keys (shorter first), sqlite keeps insertion order.
     *
     * @param  array<string, mixed>  $checks
     */
    private static function checks(array $checks): object
    {
        $out = [];
        foreach (['tags_intact', 'unused', 'original_packaging'] as $key) {
            if (array_key_exists($key, $checks)) {
                $out[$key] = (bool) $checks[$key];
            }
        }

        return (object) $out;
    }
}
