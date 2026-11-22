<?php

namespace App\Domain\Coupons;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Database\QueryException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/** §3.6 coupon CRUD (P5-11). used_count is never written here. */
class CouponService
{
    public const FIELDS = [
        'code', 'type', 'percent_bps', 'amount', 'max_discount_amount', 'applies_to', 'min_subtotal_amount',
        'usage_limit', 'usage_per_customer', 'first_order_only', 'starts_at', 'ends_at', 'status',
    ];

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param array<string, mixed> $input validated CreateCouponInput */
    public function create(Store $store, array $input, ?User $user): Coupon
    {
        $input += ['applies_to' => 'all', 'usage_per_customer' => 1, 'first_order_only' => false, 'status' => 'draft'];
        $input['starts_at'] ??= now();
        $coupon = new Coupon;
        $coupon->store_id = $store->id;
        $coupon->created_by = $user?->getKey();
        $this->apply($store, $coupon, $input);

        return $this->guard(fn () => DB::transaction(function () use ($store, $coupon, $input) {
            $coupon->save();
            $this->syncTargets($store, $coupon, $input);
            $this->audit->log('coupon.created', $coupon, ['code' => $coupon->code, 'type' => $coupon->type, 'status' => $coupon->status]);

            return $coupon;
        }));
    }

    /** @param array<string, mixed> $input validated UpdateCouponInput */
    public function update(Store $store, Coupon $coupon, array $input): Coupon
    {
        return $this->guard(fn () => DB::transaction(function () use ($store, $coupon, $input) {
            /** @var Coupon $locked */
            $locked = Coupon::query()->whereKey($coupon->id)->lockForUpdate()->firstOrFail();
            if ($locked->revision !== (int) $input['revision']) {
                throw StoreThemeService::conflict();
            }
            if ($locked->used_count > 0) {
                foreach (['code', 'type'] as $field) {
                    if (array_key_exists($field, $input) && $input[$field] !== null
                        && ($field === 'code' ? CouponValidator::normalise($input[$field]) : $input[$field]) !== $locked->{$field}) {
                        throw ValidationException::withMessages([$field => ['Create a new code instead.']]);
                    }
                }
            }
            $merged = array_merge($locked->only(self::FIELDS), array_intersect_key($input, array_flip(self::FIELDS)));
            if (($merged['type'] ?? null) === Coupon::FIXED) {
                $merged['max_discount_amount'] = array_key_exists('max_discount_amount', $input) ? $input['max_discount_amount'] : null;
            }
            if (($merged['type'] ?? null) !== Coupon::PERCENTAGE && ! array_key_exists('percent_bps', $input)) {
                $merged['percent_bps'] = null;
            }
            if (($merged['type'] ?? null) !== Coupon::FIXED && ! array_key_exists('amount', $input)) {
                $merged['amount'] = null;
            }
            if (($merged['type'] ?? null) === Coupon::FREE_SHIPPING) {
                $merged['max_discount_amount'] = null;
                $merged['applies_to'] = $input['applies_to'] ?? 'all';
            }
            $merged += ['category_ids' => $input['category_ids'] ?? null, 'product_ids' => $input['product_ids'] ?? null];
            $this->apply($store, $locked, $merged);
            $valueChanged = $locked->isDirty(['code', 'type', 'percent_bps', 'amount', 'max_discount_amount', 'status', 'usage_limit', 'starts_at', 'ends_at']);
            $changed = array_keys($locked->getDirty());
            $locked->revision++;
            $locked->save();
            $this->syncTargets($store, $locked, $merged, array_key_exists('category_ids', $input) || array_key_exists('product_ids', $input) || array_key_exists('applies_to', $input) || array_key_exists('type', $input));
            if ($valueChanged) {
                $this->audit->log('coupon.updated', $locked, ['changes' => array_values(array_diff($changed, ['revision', 'updated_at']))]);
            }

            return $locked;
        }));
    }

    public function delete(Coupon $coupon): void
    {
        DB::transaction(function () use ($coupon) {
            if (CouponRedemption::query()->where('coupon_id', $coupon->id)->exists()) {
                throw new ApiException(409, 'coupon_in_use', 'This code has been used, so it can’t be deleted. Disable it instead.');
            }
            $coupon->delete();
            $this->audit->log('coupon.deleted', $coupon, ['code' => $coupon->code]);
        });
    }

    /** Validates the type shape (P5-11) and fills the model. @param array<string, mixed> $in */
    private function apply(Store $store, Coupon $coupon, array $in): void
    {
        $errors = [];
        $code = CouponValidator::normalise((string) ($in['code'] ?? ''));
        if (! preg_match(Coupon::CODE_PATTERN, $code)) {
            $errors['code'] = ['Use 3–32 letters, numbers, dashes or underscores.'];
        } elseif (Coupon::query()->where('store_id', $store->id)->where('code', $code)->when($coupon->exists, fn ($q) => $q->whereKeyNot($coupon->id))->exists()) {
            $errors['code'] = ['This code is already used.'];
        }
        $type = $in['type'] ?? null;
        $appliesTo = $in['applies_to'] ?? 'all';
        if ($type === Coupon::PERCENTAGE) {
            if (! isset($in['percent_bps'])) {
                $errors['percent_bps'] = ['Enter a percentage between 1 and 100.'];
            }
            if (isset($in['amount'])) {
                $errors['amount'] = ['A percentage coupon has no fixed amount.'];
            }
        } elseif ($type === Coupon::FIXED) {
            if (! isset($in['amount'])) {
                $errors['amount'] = ['Enter the discount amount.'];
            }
            if (isset($in['percent_bps'])) {
                $errors['percent_bps'] = ['A fixed coupon has no percentage.'];
            }
            if (isset($in['max_discount_amount'])) {
                $errors['max_discount_amount'] = ['Only percentage coupons have a maximum discount.'];
            }
        } elseif ($type === Coupon::FREE_SHIPPING) {
            foreach (['percent_bps', 'amount', 'max_discount_amount'] as $field) {
                if (isset($in[$field])) {
                    $errors[$field] = ['Free delivery coupons have no discount value.'];
                }
            }
            if ($appliesTo !== 'all') {
                $errors['applies_to'] = ['Free delivery always applies to the whole order.'];
            }
        }
        if ($appliesTo === 'categories' && empty($in['category_ids']) && ! ($coupon->exists && $in['category_ids'] === null && $coupon->applies_to === 'categories')) {
            $errors['category_ids'] = ['Choose at least one category.'];
        }
        if ($appliesTo === 'products' && empty($in['product_ids']) && ! ($coupon->exists && $in['product_ids'] === null && $coupon->applies_to === 'products')) {
            $errors['product_ids'] = ['Choose at least one product.'];
        }
        foreach (['category_ids' => [Category::class, 'Unknown category.'], 'product_ids' => [Product::class, 'Unknown product.']] as $key => [$model, $message]) {
            $ids = array_map('strtolower', array_filter((array) ($in[$key] ?? []), 'is_string'));
            if ($ids === []) {
                continue;
            }
            $known = $model::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('id')->flip();
            foreach ($ids as $i => $id) {
                if (! isset($known[$id])) {
                    $errors["{$key}.{$i}"] = [$message];
                }
            }
        }
        $starts = Carbon::parse($in['starts_at'])->utc();
        $ends = isset($in['ends_at']) ? Carbon::parse($in['ends_at'])->utc() : null;
        if ($ends !== null && $ends->lte($starts)) {
            $errors['ends_at'] = ['The end date must be after the start date.'];
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        $coupon->fill([
            'code' => $code,
            'type' => $type,
            'percent_bps' => $type === Coupon::PERCENTAGE ? (int) $in['percent_bps'] : null,
            'amount' => $type === Coupon::FIXED ? (int) $in['amount'] : null,
            'max_discount_amount' => $type === Coupon::PERCENTAGE && isset($in['max_discount_amount']) ? (int) $in['max_discount_amount'] : null,
            'applies_to' => $appliesTo,
            'min_subtotal_amount' => $in['min_subtotal_amount'] ?? null,
            'usage_limit' => $in['usage_limit'] ?? null,
            'usage_per_customer' => $in['usage_per_customer'] ?? null,
            'first_order_only' => (bool) ($in['first_order_only'] ?? false),
            'starts_at' => $starts,
            'ends_at' => $ends,
            'status' => $in['status'] ?? 'draft',
        ]);
    }

    /** @param array<string, mixed> $in */
    private function syncTargets(Store $store, Coupon $coupon, array $in, bool $replace = true): void
    {
        if (! $replace) {
            return;
        }
        foreach (['categories' => ['coupon_categories', 'category_id', 'category_ids'], 'products' => ['coupon_products', 'product_id', 'product_ids']] as $applies => [$table, $column, $key]) {
            if ($coupon->applies_to !== $applies) {
                DB::table($table)->where('coupon_id', $coupon->id)->delete();

                continue;
            }
            if (($in[$key] ?? null) === null) {
                continue; // unchanged
            }
            DB::table($table)->where('coupon_id', $coupon->id)->delete();
            $rows = array_map(fn (string $id) => [
                'tenant_id' => $store->tenant_id, 'store_id' => $store->id, 'coupon_id' => $coupon->id, $column => strtolower($id),
            ], array_values(array_unique(array_map('strtolower', $in[$key]))));
            if ($rows !== []) {
                DB::table($table)->insert($rows);
            }
        }
    }

    /** @template T @param callable(): T $callback @return T */
    private function guard(callable $callback): mixed
    {
        try {
            return $callback();
        } catch (QueryException $e) {
            if (str_contains($e->getMessage(), 'coupons_store_id_code_unique') || str_contains($e->getMessage(), 'coupons.store_id, coupons.code')) {
                throw ValidationException::withMessages(['code' => ['This code is already used.']]);
            }
            throw $e;
        }
    }
}
