<?php

namespace App\Domain\Coupons;

use App\Domain\Catalog\Models\Category;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Support\Money;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Coupon rules (P5-11, P5-13). reason() returns the exact shopper message of §3.0, or null when the coupon applies.
 * Phone rules (per customer, first order) only run when a phone is given (checkout / manual orders).
 */
class CouponValidator
{
    public const NOT_FOUND = "This code doesn't exist.";

    public const NOT_STARTED = "This code isn't active yet.";

    public const EXPIRED = 'This code has expired.';

    public const USED_UP = 'This code has been fully used.';

    public const NOT_ELIGIBLE = "This code doesn't apply to the items in your bag.";

    public const ALREADY_USED = "You've already used this code.";

    public const FIRST_ORDER = 'This code is for first orders only.';

    public static function normalise(string $code): string
    {
        return strtoupper(trim($code));
    }

    public function find(string $storeId, ?string $code, bool $lock = false): ?Coupon
    {
        $code = self::normalise((string) $code);
        if ($code === '' || strlen($code) > 32) {
            return null;
        }

        return Coupon::query()->where('store_id', $storeId)->where('code', $code)
            ->when($lock, fn ($q) => $q->lockForUpdate())->first();
    }

    public static function minimumMessage(int $min): string
    {
        return 'Spend '.Money::bdt($min).' or more to use this code.';
    }

    /**
     * @param  int  $subtotal  merchandise subtotal of purchasable lines
     * @param  int  $eligibleSubtotal  subtotal of the lines the coupon applies to
     */
    public function reason(Coupon $coupon, int $subtotal, int $eligibleSubtotal, ?string $phone = null, ?Carbon $now = null): ?string
    {
        $now ??= now();
        if ($coupon->status === 'draft') {
            return self::NOT_FOUND;
        }
        if ($coupon->status === 'disabled' || ($coupon->ends_at !== null && $coupon->ends_at->lte($now))) {
            return self::EXPIRED;
        }
        if ($coupon->starts_at->gt($now)) {
            return self::NOT_STARTED;
        }
        if ($coupon->usage_limit !== null && $coupon->used_count >= $coupon->usage_limit) {
            return self::USED_UP;
        }
        if ($coupon->min_subtotal_amount !== null && $subtotal < $coupon->min_subtotal_amount) {
            return self::minimumMessage($coupon->min_subtotal_amount);
        }
        if ($coupon->type !== Coupon::FREE_SHIPPING && $eligibleSubtotal <= 0) {
            return self::NOT_ELIGIBLE;
        }
        if ($phone !== null) {
            if ($coupon->usage_per_customer !== null) {
                $used = CouponRedemption::query()->where('store_id', $coupon->store_id)->where('coupon_id', $coupon->id)
                    ->where('customer_phone', $phone)->where('status', CouponRedemption::ACTIVE)->count();
                if ($used >= $coupon->usage_per_customer) {
                    return self::ALREADY_USED;
                }
            }
            if ($coupon->first_order_only && Order::query()->where('store_id', $coupon->store_id)
                ->where('customer_phone', $phone)->where('status', '<>', Order::CANCELLED)->exists()) {
                return self::FIRST_ORDER;
            }
        }

        return null;
    }

    /**
     * Pricing input for CartPricer (categories expanded with their descendants).
     *
     * @return array<string, mixed>
     */
    public function pricingInput(Coupon $coupon): array
    {
        $productIds = [];
        $categoryIds = [];
        if ($coupon->applies_to === 'products') {
            $productIds = DB::table('coupon_products')->where('coupon_id', $coupon->id)->pluck('product_id')->all();
        } elseif ($coupon->applies_to === 'categories') {
            $roots = DB::table('coupon_categories')->where('coupon_id', $coupon->id)->pluck('category_id')->all();
            $categoryIds = self::withDescendants($coupon->store_id, $roots);
        }

        return [
            'type' => $coupon->type,
            'percent_bps' => $coupon->percent_bps,
            'amount' => $coupon->amount,
            'max_discount_amount' => $coupon->max_discount_amount,
            'applies_to' => $coupon->applies_to,
            'product_ids' => $productIds,
            'category_ids' => $categoryIds,
        ];
    }

    /** @param list<string> $ids @return list<string> */
    public static function withDescendants(string $storeId, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $children = [];
        foreach (Category::query()->where('store_id', $storeId)->get(['id', 'parent_id']) as $c) {
            $children[$c->parent_id ?? ''][] = $c->id;
        }
        $out = [];
        $stack = $ids;
        while ($stack !== []) {
            $id = array_pop($stack);
            if (isset($out[$id])) {
                continue;
            }
            $out[$id] = true;
            foreach ($children[$id] ?? [] as $child) {
                $stack[] = $child;
            }
        }

        return array_keys($out);
    }
}
