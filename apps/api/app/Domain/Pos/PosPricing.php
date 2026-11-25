<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Cart\CartService;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\CouponValidator;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Pricing\CartPricer;
use App\Domain\Pricing\LineLoader;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Validation\ValidationException;

/**
 * Till prices (PHASE-8-8D §5.1, P88D-7, P88D-8): the server's prices with the existing pricing and coupon code, never a
 * client price. Stock never changes the price: availability at the register location is reported per line (quote) and
 * enforced only by InventoryService::sell under the row locks (sale). Totals use the order maths (`total = subtotal −
 * discount`, no shipping, no tax); VAT is printed as included from the store tax settings.
 */
final class PosPricing
{
    public function __construct(private readonly CouponValidator $coupons) {}

    /**
     * Loads and prices the lines (active products only, P88D: draft and archived are not sold at the till). A variant
     * of another store or a deleted one → 422 `lines.{i}.variant_id` "Unknown variant." (foreign-id rule, S195); with
     * $strict, a disabled variant or an archived product is a 422 too (sale), else the line is priced out with
     * problem `unavailable` (quote).
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @return array{loaded: array{lines: list<array<string, mixed>>, variants: array<string, ProductVariant>}, plain: array<string, mixed>}
     */
    public static function load(string $storeId, array $lines, bool $strict): array
    {
        $items = [];
        foreach (array_values($lines) as $i => $line) {
            $items[] = ['key' => $i, 'variant_id' => strtolower((string) $line['variant_id']), 'quantity' => (int) $line['quantity']];
        }
        $loaded = LineLoader::load($storeId, $items, [Product::ACTIVE]);
        $errors = [];
        foreach ($loaded['lines'] as $i => $line) {
            $variant = $loaded['variants'][$line['variant_id']] ?? null;
            if ($variant === null || $variant->trashed() || $variant->product === null || $variant->product->trashed()) {
                $errors["lines.{$i}.variant_id"] = ['Unknown variant.'];
            } elseif ($strict && ! $line['purchasable']) {
                $errors["lines.{$i}.variant_id"] = [match (true) {
                    $variant->product->status === Product::ARCHIVED => 'This product is archived.',
                    $variant->product->status === Product::DRAFT => 'This product is a draft. Publish it to sell it.',
                    default => 'This variant is turned off.',
                }];
            }
            // Stock never prices a line out at the till (sell() is the authority, under the locks).
            $loaded['lines'][$i]['tracked'] = false;
            $loaded['lines'][$i]['tracked_stock'] = $line['tracked'];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return ['loaded' => $loaded, 'plain' => CartPricer::price($loaded['lines'])];
    }

    /**
     * Applies an optional coupon code. A missing / invalid code → 422 `coupon_invalid` (details.code). A free-shipping
     * coupon has nothing to discount at the till → NOT_ELIGIBLE. $lock = the sale's authoritative pass (row lock).
     *
     * @param  array{lines: list<array<string, mixed>>}  $loaded
     * @param  array<string, mixed>  $plain  CartPricer result without coupon
     * @return array{priced: array<string, mixed>, coupon: Coupon|null}
     */
    public function applyCoupon(string $storeId, array $loaded, array $plain, ?string $code, ?string $phone, bool $lock = false): array
    {
        if ($code === null || trim($code) === '') {
            return ['priced' => $plain, 'coupon' => null];
        }
        $coupon = $this->coupons->find($storeId, $code, lock: $lock);
        if ($coupon === null) {
            throw CartService::couponInvalid(CouponValidator::NOT_FOUND);
        }
        if ($coupon->type === Coupon::FREE_SHIPPING) {
            throw CartService::couponInvalid(CouponValidator::NOT_ELIGIBLE);
        }
        $priced = CartPricer::price($loaded['lines'], $this->coupons->pricingInput($coupon));
        $reason = $this->coupons->reason($coupon, $priced['subtotal'], $priced['eligible_subtotal'], $phone);
        if ($reason !== null) {
            throw CartService::couponInvalid($reason);
        }

        return ['priced' => $priced, 'coupon' => $coupon];
    }

    /**
     * PosQuote (§5.1): read-only, no locks.
     *
     * @param  list<array{variant_id: string, quantity: int}>  $lines
     * @return array<string, mixed>
     */
    public function quote(string $storeId, string $locationId, string $currency, array $lines, ?string $couponCode, ?string $phone): array
    {
        ['loaded' => $loaded, 'plain' => $plain] = self::load($storeId, $lines, strict: false);
        ['priced' => $priced, 'coupon' => $coupon] = $this->applyCoupon($storeId, $loaded, $plain, $couponCode, $phone);
        $available = self::availableAt($storeId, $locationId, array_column($loaded['lines'], 'variant_id'));

        $wanted = [];
        foreach ($loaded['lines'] as $line) {
            $wanted[$line['variant_id']] = ($wanted[$line['variant_id']] ?? 0) + (int) $line['quantity'];
        }
        $out = [];
        $items = 0;
        foreach ($priced['lines'] as $i => $p) {
            $in = $loaded['lines'][$i];
            /** @var ProductVariant $variant */
            $variant = $loaded['variants'][$in['variant_id']];
            $stock = $in['tracked_stock'] ? ($available[$in['variant_id']] ?? 0) : null;
            $problem = match (true) {
                ! $in['purchasable'] => 'unavailable',
                $stock !== null && $stock <= 0 => 'out_of_stock',
                $stock !== null && $stock < $wanted[$in['variant_id']] => 'not_enough_stock',
                default => null,
            };
            if ($problem !== 'unavailable') {
                $items += (int) $in['quantity'];
            }
            $out[] = [
                'variant_id' => $in['variant_id'],
                'name' => (string) $variant->product->name,
                'variant_title' => (string) $variant->title,
                'quantity' => (int) $in['quantity'],
                'unit_price_amount' => (int) $p['unit_price_amount'],
                'compare_at_amount' => $p['compare_at_amount'],
                'line_total_amount' => $p['issue'] === null ? (int) $p['line_amount'] - (int) $p['discount_amount'] : 0,
                'available' => $stock,
                'problem' => $problem,
            ];
        }
        $total = (int) $priced['subtotal'] - (int) $priced['discount'];

        return [
            'currency' => $currency,
            'lines' => $out,
            'items_count' => $items,
            'subtotal_amount' => (int) $priced['subtotal'],
            'discount_amount' => (int) $priced['discount'],
            'coupon_code' => $coupon?->code,
            'vat' => self::vat($storeId, $total),
            'total_amount' => $total,
        ];
    }

    /**
     * on_hand − committed per variant at one location (unlocked read; a missing row = 0). @param list<string> $variantIds
     *
     * @return array<string, int>
     */
    public static function availableAt(string $storeId, string $locationId, array $variantIds): array
    {
        $ids = array_values(array_unique($variantIds));
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach (Inventory::query()->where('store_id', $storeId)->where('location_id', $locationId)->whereIn('variant_id', $ids)
            ->get(['variant_id', 'on_hand', 'committed']) as $row) {
            $out[$row->variant_id] = max(0, (int) $row->on_hand - (int) $row->committed);
        }

        return $out;
    }

    /**
     * Included VAT printed on the receipt (P88D-8, Q52): floor(total × rate / (10 000 + rate)) when the store's tax
     * display is `included` (the same formula as the 5b documents, P5B-56); null when tax display is off.
     *
     * @return array{rate_bps: int, amount: int}|null
     */
    public static function vat(string $storeId, int $total): ?array
    {
        $settings = StoreSetting::query()->where('store_id', $storeId)->first(['tax_display', 'tax_rate_bps']);
        if ($settings?->tax_display !== 'included') {
            return null;
        }
        $rate = max(0, (int) $settings->tax_rate_bps);

        return ['rate_bps' => $rate, 'amount' => PosMoney::includedVat($total, $rate)];
    }
}
