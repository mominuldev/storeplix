<?php

namespace App\Domain\Orders;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\CouponValidator;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\InventoryService;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Orders\Notifications\OrderNotifier;
use App\Domain\Pricing\CartPricer;
use App\Domain\Pricing\LineLoader;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Edit items of an unshipped order (P5B-60–P5B-62, §8). `quote()` is the same math without writes.
 *
 * - Input is the full desired line set: `id` for existing lines (quantity 0 removes; omitted lines are removed),
 *   `variant_id` for new lines.
 * - Existing lines keep their snapshot unit price / compare-at / cost; new lines use the current price (manual-order
 *   eligibility: active or draft, not archived, variant enabled).
 * - The order's coupon is re-applied to the new eligible subtotal (no new redemption, limits not re-checked); when its
 *   minimum is no longer met it is removed and its redemption released (notice).
 * - Shipping stays unless `recalculate_shipping` or `shipping_amount_override`.
 * - New total ≥ paid − refunded, else 422 total_below_paid.
 * - Stock moves by the difference under the 5a lock order: order → inventories (variant_id, all affected rows locked
 *   at once) → coupon. One `items_edited` event; optional `order_updated` SMS after commit.
 */
class OrderItemEditor
{
    public function __construct(
        private readonly InventoryService $inventory,
        private readonly ZoneResolver $zones,
        private readonly OrderNotifier $notifier,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    /**
     * @param  array<string, mixed>  $input  validated EditOrderItemsInput
     * @return array<string, mixed> OrderItemsQuote
     */
    public function quote(Order $order, array $input): array
    {
        $plan = $this->plan($order, OrderItem::query()->where('order_id', $order->id)->orderBy('position')->orderBy('id')->get()->all(), $input, strict: false);

        return $this->present($order, $plan);
    }

    /**
     * @param  array<string, mixed>  $input  validated EditOrderItemsInput
     * @return array{0: Order, 1: list<string>}
     */
    public function apply(Order $order, array $input, ?User $user): array
    {
        $eventId = null;
        $notices = [];
        $order = DB::transaction(function () use ($order, $input, $user, &$eventId, &$notices) {
            /** @var Order $o */
            $o = Order::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
            if ($o->revision !== (int) $input['revision']) {
                throw StoreThemeService::conflict();
            }
            if (! in_array($o->status, Order::EDITABLE, true)) {
                throw new ApiException(409, 'invalid_state_transition', 'Items can only be changed before the order ships.');
            }
            self::assertNotBooked($o);

            /** @var list<OrderItem> $items */
            $items = OrderItem::query()->where('order_id', $o->id)->orderBy('position')->orderBy('id')->get()->all();
            $plan = $this->plan($o, $items, $input, strict: true);
            $notices = $plan['notices'];
            if ($plan['total'] < $o->paid_amount - $o->refunded_amount) {
                $message = 'The new total ('.Money::bdt($plan['total']).') is below what the customer already paid. Refund first.';
                throw new ApiException(422, 'total_below_paid', $message, ['items' => [$message]]);
            }

            $this->moveStock($o, $plan, $user);
            $this->releaseCoupon($o, $plan, $user);
            $this->writeItems($o, $plan);

            $previousTotal = $o->total_amount;
            $o->subtotal_amount = $plan['subtotal'];
            $o->discount_amount = $plan['discount'];
            $o->shipping_amount = $plan['shipping'];
            $o->shipping_discount_amount = $plan['shipping_discount'];
            $o->shipping_overridden = $plan['shipping_overridden'];
            $o->total_amount = $plan['total'];
            if ($plan['coupon_removed']) {
                $o->coupon_id = null;
                $o->coupon_code = null;
            }
            self::syncPaymentStatus($o);
            $o->revision++;
            $o->save();
            self::syncCodCharge($o);

            $changes = [];
            foreach ($plan['lines'] as $line) {
                if ($line['change'] !== 'unchanged') {
                    $changes[] = ['product_name' => $line['product_name'], 'variant_title' => $line['variant_title'], 'from' => $line['old'], 'to' => $line['quantity']];
                }
            }
            $meta = [
                'reason' => $input['reason'],
                'changes' => $changes,
                'previous_total_amount' => $previousTotal,
                'total_amount' => $o->total_amount,
            ];
            if ($plan['shipping_overridden'] && array_key_exists('shipping_amount_override', $input) && $input['shipping_amount_override'] !== null) {
                $meta['shipping_overridden'] = true;
            }
            $eventId = OrderTimeline::record($o, 'items_edited', $user, $input['note'] ?? null, $meta)->id;
            $this->audit->log('order.items_edited', $o, ['reason' => $input['reason'], 'lines' => count($changes), 'previous_total' => $previousTotal, 'total' => $o->total_amount], $user);

            return $o;
        });

        $this->notifier->sms($order, 'order_updated', array_key_exists('notify_customer', $input) ? (bool) $input['notify_customer'] : null, ref: $eventId);

        return [$order, $notices];
    }

    /** Q56: no item edits while a courier parcel is booked (cancel it first). Manual shipments only exist once shipped. */
    public static function assertNotBooked(Order $order): void
    {
        $booked = Shipment::query()->where('order_id', $order->id)->where('provider', '<>', 'manual')
            ->whereNotIn('status', ['cancelled', 'booking_failed'])->exists();
        if ($booked) {
            throw new ApiException(409, 'shipment_booked', 'This order is booked with a courier. Cancel the parcel first to edit items.');
        }
    }

    /** payment_status after a total change (refund states are kept). */
    public static function syncPaymentStatus(Order $o): void
    {
        if ($o->refunded_amount > 0) {
            return;
        }
        if ($o->paid_amount === 0) {
            $o->payment_status = $o->total_amount === 0 ? 'paid' : 'unpaid';
        } else {
            $o->payment_status = $o->paid_amount >= $o->total_amount ? 'paid' : 'partially_paid';
        }
    }

    /** §8: the pending COD charge = new total − paid (updated in place; cancelled at 0; created when missing). */
    public static function syncCodCharge(Order $o): void
    {
        $due = $o->total_amount - $o->paid_amount;
        $charge = Payment::query()->where('order_id', $o->id)->where('provider', 'cod')->where('type', 'charge')->where('status', 'pending')->first();
        if ($charge !== null) {
            if ($due > 0) {
                $charge->amount = $due;
            } else {
                $charge->status = 'cancelled';
            }
            $charge->save();
        } elseif ($due > 0 && $o->payment_method === 'cod') {
            $payment = new Payment;
            $payment->store_id = $o->store_id;
            $payment->order_id = $o->id;
            $payment->provider = 'cod';
            $payment->type = 'charge';
            $payment->status = 'pending';
            $payment->amount = $due;
            $payment->currency = $o->currency;
            $payment->save();
        }
    }

    /**
     * @param  list<OrderItem>  $items
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    private function plan(Order $order, array $items, array $input, bool $strict): array
    {
        $byId = [];
        foreach ($items as $item) {
            $byId[$item->id] = $item;
        }
        $errors = [];
        $seen = [];
        $rows = []; // ['item' => ?OrderItem, 'variant_id' => ?string, 'quantity' => int, 'field' => string]
        // Validated nested arrays can come back with their keys out of order: keep the request's indexes (error paths).
        $requested = $input['items'];
        ksort($requested);
        foreach ($requested as $i => $row) {
            $id = isset($row['id']) && $row['id'] !== null ? strtolower((string) $row['id']) : null;
            $quantity = (int) $row['quantity'];
            if ($id !== null) {
                $item = $byId[$id] ?? null;
                if ($item === null) {
                    $errors["items.{$i}.id"] = ['Unknown item.'];

                    continue;
                }
                if (isset($seen[$id])) {
                    $errors["items.{$i}.id"] = ['Each line can appear once.'];

                    continue;
                }
                $seen[$id] = true;
                $rows[] = ['item' => $item, 'variant_id' => $item->variant_id, 'quantity' => $quantity, 'field' => "items.{$i}"];
            } elseif (isset($row['variant_id']) && $row['variant_id'] !== null) {
                if ($quantity === 0) {
                    continue; // a new line at 0 is no line
                }
                $rows[] = ['item' => null, 'variant_id' => strtolower((string) $row['variant_id']), 'quantity' => $quantity, 'field' => "items.{$i}"];
            } else {
                $errors["items.{$i}.variant_id"] = ['Choose a product.'];
            }
        }
        // Omitted existing lines are removed (the input is the full desired line set).
        foreach ($items as $item) {
            if (! isset($seen[$item->id])) {
                $rows[] = ['item' => $item, 'variant_id' => $item->variant_id, 'quantity' => 0, 'field' => 'items'];
            }
        }

        $loadIds = [];
        foreach ($rows as $k => $row) {
            if ($row['variant_id'] !== null) {
                $loadIds[] = ['key' => $k, 'variant_id' => $row['variant_id'], 'quantity' => max(1, $row['quantity'])];
            }
        }
        $loaded = LineLoader::load($order->store_id, $loadIds, [Product::ACTIVE, Product::DRAFT]);
        $loadedByKey = [];
        foreach ($loaded['lines'] as $l) {
            $loadedByKey[$l['key']] = $l;
        }

        // Variants kept on existing lines: a new line can't repeat one (change its quantity instead).
        $keptVariants = [];
        foreach ($rows as $row) {
            if ($row['item'] !== null && $row['quantity'] > 0 && $row['variant_id'] !== null) {
                $keptVariants[$row['variant_id']] = true;
            }
        }
        $newVariants = [];
        foreach ($rows as $k => $row) {
            if ($row['item'] !== null) {
                continue;
            }
            $variant = $loaded['variants'][$row['variant_id']] ?? null;
            $field = $row['field'].'.variant_id';
            if ($variant === null || $variant->trashed() || $variant->product === null || $variant->product->trashed()) {
                $errors[$field] = ['Unknown variant.'];
            } elseif (isset($keptVariants[$row['variant_id']]) || isset($newVariants[$row['variant_id']])) {
                $errors[$field] = ['This variant is already in the order. Change its quantity instead.'];
            } elseif ($strict && ! ($loadedByKey[$k]['purchasable'] ?? false)) {
                $errors[$field] = [$variant->product->status === Product::ARCHIVED ? 'This product is archived.' : 'This variant is turned off.'];
            }
            $newVariants[$row['variant_id']] = true;
        }
        $active = count(array_filter($rows, fn ($r) => $r['quantity'] > 0));
        if ($errors === [] && $active === 0) {
            $errors['items'] = ['Keep at least one item. To drop the whole order, cancel it.'];
        }
        if ($active > Order::MAX_ITEMS) {
            $errors['items'] = ['An order can have at most '.Order::MAX_ITEMS.' items.'];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        // Pricing lines (every non-removed line is priced; stock problems are reported separately as `issue`).
        $lines = [];
        $pricer = [];
        foreach ($rows as $k => $row) {
            /** @var OrderItem|null $item */
            $item = $row['item'];
            $l = $loadedByKey[$k] ?? null;
            /** @var ProductVariant|null $variant */
            $variant = $row['variant_id'] !== null ? ($loaded['variants'][$row['variant_id']] ?? null) : null;
            $old = $item?->quantity ?? 0;
            $tracked = $item !== null ? $item->tracked && $item->variant_id !== null && $variant !== null : (bool) ($l['tracked'] ?? false);
            $backorder = (bool) ($l['backorder'] ?? false);
            $available = (int) ($l['available'] ?? 0) + ($tracked ? $old : 0);
            $issue = null;
            if ($item === null && ! ($l['purchasable'] ?? false)) {
                $issue = 'unavailable';
            } elseif ($tracked && ! $backorder && $row['quantity'] > $old && $available < $row['quantity']) {
                $issue = 'insufficient_stock';
            }
            $change = match (true) {
                $item === null => 'added',
                $row['quantity'] === 0 => 'removed',
                $row['quantity'] === $old => 'unchanged',
                default => 'changed',
            };
            $line = [
                'item' => $item,
                'variant' => $variant,
                'variant_id' => $row['variant_id'],
                'quantity' => $row['quantity'],
                'old' => $old,
                'tracked' => $tracked,
                'backorder' => $backorder,
                'field' => $row['field'].'.quantity',
                'change' => $change,
                'issue' => $issue,
                'product_name' => $item?->product_name ?? (string) $variant?->product?->name,
                'variant_title' => $item?->variant_title ?? (string) $variant?->title,
                'unit_price_amount' => $item?->unit_price_amount ?? (int) ($l['price'] ?? 0),
                'compare_at_amount' => $item !== null ? $item->compare_at_amount : ($l['compare_at'] ?? null),
                'pricer_index' => null,
            ];
            if ($row['quantity'] > 0) {
                $line['pricer_index'] = count($pricer);
                $pricer[] = [
                    'key' => $k,
                    'variant_id' => $row['variant_id'],
                    'product_id' => $item?->product_id ?? $l['product_id'] ?? null,
                    'category_ids' => $l['category_ids'] ?? [],
                    'quantity' => $row['quantity'],
                    'price' => $line['unit_price_amount'],
                    'compare_at' => $line['compare_at_amount'],
                    'purchasable' => true,
                    'tracked' => false, // stock is checked above / by InventoryService::commit, not by the pricer
                    'backorder' => true,
                    'available' => 0,
                ];
            }
            $lines[] = $line;
        }

        // Coupon re-application (P5B-61).
        $notices = [];
        $coupon = $order->coupon_id !== null ? Coupon::query()->where('store_id', $order->store_id)->whereKey($order->coupon_id)->first() : null;
        $couponInput = $coupon !== null ? app(CouponValidator::class)->pricingInput($coupon) : null;
        $priced = CartPricer::price($pricer, $couponInput);
        $couponRemoved = false;
        if ($coupon !== null && $coupon->min_subtotal_amount !== null && $priced['subtotal'] < $coupon->min_subtotal_amount) {
            $couponRemoved = true;
            $notices[] = "Coupon {$coupon->code} was removed: the order is now below its ".Money::bdt($coupon->min_subtotal_amount).' minimum.';
            $priced = CartPricer::price($pricer);
            $coupon = null;
        } elseif ($order->coupon_id !== null && $coupon === null) {
            $priced = CartPricer::price($pricer);
        }

        // Shipping (P5-19 rules): kept, recalculated from the zone, or overridden.
        $merchandise = $priced['subtotal'] - $priced['discount'];
        $override = $input['shipping_amount_override'] ?? null;
        if ($override !== null) {
            $shipping = ['shipping' => (int) $override, 'shipping_discount' => 0, 'coupon_shipping_discount' => 0];
            $overridden = true;
        } elseif (! empty($input['recalculate_shipping'])) {
            $address = $order->shipping_address;
            $zone = $this->zones->resolve($order->store_id, (string) ($address['district_code'] ?? ''), (string) ($address['thana_code'] ?? ''));
            $shipping = CartPricer::shipping($zone?->charge_amount ?? 0, ZoneResolver::freeOver($order->store_id), $merchandise, $coupon?->type === Coupon::FREE_SHIPPING);
            $overridden = false;
            if ($shipping['shipping'] !== $order->shipping_amount) {
                $notices[] = 'Delivery charge recalculated: '.Money::bdt($shipping['shipping']).'.';
            }
        } else {
            $shipping = ['shipping' => $order->shipping_amount, 'shipping_discount' => $order->shipping_discount_amount, 'coupon_shipping_discount' => $coupon?->type === Coupon::FREE_SHIPPING ? $order->shipping_discount_amount : 0];
            $overridden = $order->shipping_overridden;
        }
        $total = $merchandise + $shipping['shipping'] + $order->tax_amount;
        if (! $strict && $total < $order->paid_amount - $order->refunded_amount) {
            $notices[] = 'The new total is below what the customer already paid. Refund first.';
        }

        foreach ($lines as $k => $line) {
            $p = $line['pricer_index'] !== null ? $priced['lines'][$line['pricer_index']] : null;
            $lines[$k]['subtotal_amount'] = $p['line_amount'] ?? 0;
            $lines[$k]['discount_amount'] = $p['discount_amount'] ?? 0;
        }

        return [
            'lines' => $lines,
            'subtotal' => $priced['subtotal'],
            'discount' => $priced['discount'],
            'shipping' => $shipping['shipping'],
            'shipping_discount' => $shipping['shipping_discount'],
            'coupon_shipping_discount' => $shipping['coupon_shipping_discount'],
            'shipping_overridden' => $overridden,
            'total' => $total,
            'coupon' => $coupon,
            'coupon_removed' => $couponRemoved,
            'notices' => $notices,
        ];
    }

    /** @param array<string, mixed> $plan */
    private function moveStock(Order $o, array $plan, ?User $user): void
    {
        $commit = [];
        $release = [];
        $ids = [];
        foreach ($plan['lines'] as $line) {
            if (! $line['tracked'] || $line['variant_id'] === null) {
                continue;
            }
            $delta = $line['quantity'] - $line['old'];
            if ($delta > 0) {
                $commit[] = ['variant_id' => $line['variant_id'], 'quantity' => $delta, 'allow_backorder' => $line['backorder'], 'field' => $line['field']];
            } elseif ($delta < 0) {
                $release[] = ['variant_id' => $line['variant_id'], 'quantity' => -$delta];
            }
            if ($delta !== 0) {
                $ids[] = $line['variant_id'];
            }
        }
        if ($ids === []) {
            return;
        }
        // All affected inventory rows in ONE sorted lock pass (§7), so commit + release can't deadlock a checkout.
        $ids = array_values(array_unique($ids));
        sort($ids, SORT_STRING);
        Inventory::query()->where('store_id', $o->store_id)->whereIn('variant_id', $ids)->orderBy('variant_id')->lockForUpdate()->get(['id']);
        $this->inventory->commit($o->store_id, $commit);
        $this->inventory->release($o->store_id, $release);
    }

    /** @param array<string, mixed> $plan */
    private function releaseCoupon(Order $o, array $plan, ?User $user): void
    {
        $redemption = CouponRedemption::query()->where('order_id', $o->id)->where('status', CouponRedemption::ACTIVE)->first();
        if ($redemption === null) {
            return;
        }
        if ($plan['coupon_removed']) {
            Coupon::query()->whereKey($redemption->coupon_id)->lockForUpdate()->first();
            $redemption->status = CouponRedemption::RELEASED;
            $redemption->save();
            Coupon::query()->whereKey($redemption->coupon_id)->where('used_count', '>', 0)->update(['used_count' => DB::raw('used_count - 1')]);
            OrderTimeline::record($o, 'coupon_released', $user, null, ['code' => $o->coupon_code]);
        } elseif ($plan['coupon'] !== null) {
            $redemption->discount_amount = $plan['discount'] + $plan['coupon_shipping_discount'];
            $redemption->save();
        }
    }

    /** @param array<string, mixed> $plan */
    private function writeItems(Order $o, array $plan): void
    {
        $position = (int) OrderItem::query()->where('order_id', $o->id)->max('position');
        foreach ($plan['lines'] as $line) {
            /** @var OrderItem|null $item */
            $item = $line['item'];
            if ($item !== null && $line['quantity'] === 0) {
                $item->delete();

                continue;
            }
            if ($item === null) {
                /** @var ProductVariant $variant */
                $variant = $line['variant'];
                $product = $variant->product;
                $item = new OrderItem;
                $item->store_id = $o->store_id;
                $item->order_id = $o->id;
                $item->product_id = $product->id;
                $item->variant_id = $variant->id;
                $item->product_name = $product->name;
                $item->variant_title = $variant->title;
                $item->option_values = $variant->optionValues(count($product->options ?? []));
                $item->sku = $variant->sku;
                $item->image_media_id = $variant->image_media_id ?? $product->images->first()?->media_id;
                $item->unit_price_amount = $line['unit_price_amount'];
                $item->compare_at_amount = $line['compare_at_amount'];
                $item->unit_cost_amount = $variant->cost_amount;
                $item->tracked = $line['tracked'];
                $item->position = ++$position;
            }
            $item->quantity = $line['quantity'];
            $item->subtotal_amount = $line['subtotal_amount'];
            $item->discount_amount = $line['discount_amount'];
            $item->total_amount = $line['subtotal_amount'] - $line['discount_amount'];
            if ($item->isDirty()) {
                $item->save();
            }
        }
    }

    /**
     * @param  array<string, mixed>  $plan
     * @return array<string, mixed> OrderItemsQuote
     */
    private function present(Order $order, array $plan): array
    {
        $costs = $this->context->allows(Permission::CostsView);
        $mediaIds = [];
        foreach ($plan['lines'] as $line) {
            $mediaIds[] = $line['item']?->image_media_id ?? $line['variant']?->image_media_id ?? $line['variant']?->product?->images->first()?->media_id;
        }
        $media = MediaMaps::load(array_values(array_filter($mediaIds)));
        $out = [];
        foreach ($plan['lines'] as $k => $line) {
            /** @var OrderItem|null $item */
            $item = $line['item'];
            /** @var ProductVariant|null $variant */
            $variant = $line['variant'];
            $product = $variant?->product;
            $mediaId = $mediaIds[$k];
            $out[] = [
                'id' => $item?->id,
                'product_id' => $item?->product_id ?? $product?->id,
                'variant_id' => $line['variant_id'],
                'product_name' => $line['product_name'],
                'variant_title' => $line['variant_title'],
                'option_values' => $item !== null ? array_values($item->option_values ?? []) : ($variant && $product ? $variant->optionValues(count($product->options ?? [])) : []),
                'sku' => $item !== null ? $item->sku : $variant?->sku,
                'image' => MediaPresenter::ref($mediaId ? ($media[$mediaId] ?? null) : null),
                'unit_price_amount' => $line['unit_price_amount'],
                'compare_at_amount' => $line['compare_at_amount'],
                'unit_cost_amount' => $costs ? ($item !== null ? $item->unit_cost_amount : $variant?->cost_amount) : null,
                'quantity' => $line['quantity'],
                'subtotal_amount' => $line['subtotal_amount'],
                'discount_amount' => $line['discount_amount'],
                'total_amount' => $line['subtotal_amount'] - $line['discount_amount'],
                'current_stock' => OrderPresenter::stock($variant),
                'change' => $line['change'],
                'issue' => $line['issue'],
            ];
        }
        $due = max(0, $plan['total'] - $order->paid_amount);

        return [
            'lines' => $out,
            'subtotal_amount' => $plan['subtotal'],
            'discount_amount' => $plan['discount'],
            'shipping_amount' => $plan['shipping'],
            'total_amount' => $plan['total'],
            'previous_total_amount' => $order->total_amount,
            'due_amount' => $due,
            'due_delta_amount' => $due - $order->dueAmount(),
            'notices' => $plan['notices'],
        ];
    }
}
