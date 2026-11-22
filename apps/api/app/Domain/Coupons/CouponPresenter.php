<?php

namespace App\Domain\Coupons;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Facades\DB;

/** Coupon payload (@storeplix/types). */
final class CouponPresenter
{
    /** @return list<string> eager loads for present() */
    public static function with(): array
    {
        return ['categories', 'products.images.media', 'createdBy'];
    }

    /**
     * @param  array<string, array{orders_count: int, revenue_amount: int, discount_amount: int}>  $stats  keyed by coupon id
     * @return array<string, mixed>
     */
    public static function present(Coupon $coupon, array $stats = []): array
    {
        $s = $stats[$coupon->id] ?? self::stats([$coupon->id])[$coupon->id] ?? ['orders_count' => 0, 'revenue_amount' => 0, 'discount_amount' => 0];

        return [
            'id' => $coupon->id,
            'code' => $coupon->code,
            'type' => $coupon->type,
            'percent_bps' => $coupon->percent_bps,
            'amount' => $coupon->amount,
            'max_discount_amount' => $coupon->max_discount_amount,
            'applies_to' => $coupon->applies_to,
            'categories' => $coupon->applies_to === 'categories'
                ? $coupon->categories->map(fn ($c) => ['id' => $c->id, 'name' => $c->name, 'slug' => $c->slug])->values()->all()
                : [],
            'products' => $coupon->applies_to === 'products'
                ? $coupon->products->map(fn (Product $p) => [
                    'id' => $p->id, 'name' => $p->name,
                    'image' => MediaPresenter::ref($p->images->first()?->media),
                    'price_min_amount' => $p->price_min_amount,
                ])->values()->all()
                : [],
            'min_subtotal_amount' => $coupon->min_subtotal_amount,
            'usage_limit' => $coupon->usage_limit,
            'usage_per_customer' => $coupon->usage_per_customer,
            'first_order_only' => $coupon->first_order_only,
            'starts_at' => UserRef::iso($coupon->starts_at),
            'ends_at' => UserRef::iso($coupon->ends_at),
            'status' => $coupon->status,
            'display_status' => $coupon->displayStatus(),
            'stats' => [
                'used_count' => $coupon->used_count,
                'orders_count' => $s['orders_count'],
                'revenue_amount' => $s['revenue_amount'],
                'discount_amount' => $s['discount_amount'],
            ],
            'share_path' => '/discount/'.rawurlencode($coupon->code),
            'revision' => $coupon->revision,
            'created_by' => UserRef::of($coupon->createdBy),
            'created_at' => UserRef::iso($coupon->created_at),
            'updated_at' => UserRef::iso($coupon->updated_at),
        ];
    }

    /**
     * Coupon.stats: non-cancelled orders and their revenue, plus the active redemption discount.
     *
     * @param  list<string>  $ids
     * @return array<string, array{orders_count: int, revenue_amount: int, discount_amount: int}>
     */
    public static function stats(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $orders = DB::table('orders')->whereIn('coupon_id', $ids)->where('status', '<>', 'cancelled')
            ->groupBy('coupon_id')->selectRaw('coupon_id, count(*) as n, coalesce(sum(total_amount), 0) as revenue')->get()->keyBy('coupon_id');
        $discounts = DB::table('coupon_redemptions')->whereIn('coupon_id', $ids)->where('status', 'active')
            ->groupBy('coupon_id')->selectRaw('coupon_id, coalesce(sum(discount_amount), 0) as discount')->pluck('discount', 'coupon_id');
        $out = [];
        foreach ($ids as $id) {
            $out[$id] = [
                'orders_count' => (int) ($orders[$id]->n ?? 0),
                'revenue_amount' => (int) ($orders[$id]->revenue ?? 0),
                'discount_amount' => (int) ($discounts[$id] ?? 0),
            ];
        }

        return $out;
    }
}
