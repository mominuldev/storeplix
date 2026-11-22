<?php

namespace App\Domain\Coupons\Http;

use App\Domain\Coupons\CouponPresenter;
use App\Domain\Coupons\CouponService;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;

/** §3.6 coupons. Reads O A S (Operate); writes O A (ManageMarketing). */
class CouponController
{
    public function __construct(
        private readonly CouponService $coupons,
        private readonly TenantContext $context,
    ) {}

    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $statuses = implode('|', Coupon::DISPLAY_STATUSES);
        $input = $request->validate([
            'q' => ['sometimes', 'nullable', 'string', 'max:32'],
            'filter' => ['sometimes', 'array:type,status'],
            'filter.type' => ['sometimes', 'string', 'regex:/^(percentage|fixed|free_shipping)(,(percentage|fixed|free_shipping))*$/'],
            'filter.status' => ['sometimes', 'string', "regex:/^({$statuses})(,({$statuses}))*$/"],
            'sort' => ['sometimes', 'string', 'in:-created_at,-revenue,-used_count'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);

        $base = fn () => Coupon::query()->where('coupons.store_id', $store->id);
        $query = $base();
        if (($q = trim((string) ($input['q'] ?? ''))) !== '') {
            $query->where('code', 'like', '%'.addcslashes(strtoupper($q), '%_\\').'%');
        }
        if (isset($input['filter']['type'])) {
            $query->whereIn('type', explode(',', $input['filter']['type']));
        }
        if (isset($input['filter']['status'])) {
            $wanted = explode(',', $input['filter']['status']);
            $query->where(function (Builder $w) use ($wanted) {
                foreach ($wanted as $status) {
                    $w->orWhere(fn (Builder $q) => self::whereDisplay($q, $status));
                }
            });
        }
        match ($input['sort'] ?? '-created_at') {
            '-revenue' => $query->orderByDesc(DB::table('orders')->selectRaw('coalesce(sum(total_amount), 0)')
                ->whereColumn('orders.coupon_id', 'coupons.id')->where('orders.status', '<>', 'cancelled'))->orderByDesc('coupons.id'),
            '-used_count' => $query->orderByDesc('used_count')->orderByDesc('coupons.id'),
            default => $query->orderByDesc('coupons.created_at')->orderByDesc('coupons.id'),
        };
        $page = $query->select('coupons.*')->with(CouponPresenter::with())->paginate((int) ($input['per_page'] ?? 25));
        $stats = CouponPresenter::stats($page->getCollection()->pluck('id')->all());

        $counts = ['all' => $base()->count()];
        foreach (['active', 'scheduled', 'expired'] as $status) {
            $counts[$status] = $base()->where(fn (Builder $q) => self::whereDisplay($q, $status))->count();
        }

        return new JsonResponse([
            'data' => $page->getCollection()->map(fn (Coupon $c) => CouponPresenter::present($c, $stats))->all(),
            'meta' => [
                'current_page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
                'counts' => $counts,
            ],
        ]);
    }

    public function store(Request $request, Store $store): JsonResponse
    {
        $this->authorizeWrite($store);
        $coupon = $this->coupons->create($store, $this->input($request, true), $request->user());

        return $this->one($coupon, 201);
    }

    public function show(Store $store, Coupon $coupon): JsonResponse
    {
        Gate::authorize('view', $store);

        return $this->one($coupon);
    }

    public function update(Request $request, Store $store, Coupon $coupon): JsonResponse
    {
        $this->authorizeWrite($store);

        return $this->one($this->coupons->update($store, $coupon, $this->input($request, false)));
    }

    public function destroy(Store $store, Coupon $coupon): Response
    {
        $this->authorizeWrite($store);
        $this->coupons->delete($coupon);

        return response()->noContent();
    }

    /** SQL for a derived display status (P5-11). */
    public static function whereDisplay(Builder $q, string $status): void
    {
        $now = now();
        $notExpired = fn (Builder $w) => $w->whereNull('ends_at')->orWhere('ends_at', '>', $now);
        $notUsedUp = fn (Builder $w) => $w->whereNull('usage_limit')->orWhereColumn('used_count', '<', 'usage_limit');
        match ($status) {
            'draft', 'disabled' => $q->where('status', $status),
            'expired' => $q->where('status', 'active')->whereNotNull('ends_at')->where('ends_at', '<=', $now),
            'used_up' => $q->where('status', 'active')->where($notExpired)->whereNotNull('usage_limit')->whereColumn('used_count', '>=', 'usage_limit'),
            'scheduled' => $q->where('status', 'active')->where($notExpired)->where($notUsedUp)->where('starts_at', '>', $now),
            default => $q->where('status', 'active')->where($notExpired)->where($notUsedUp)->where('starts_at', '<=', $now),
        };
    }

    private function authorizeWrite(Store $store): void
    {
        Gate::authorize('view', $store);
        if (! Permission::ManageMarketing->grantedTo($this->context->role())) {
            throw new ApiException(403, 'forbidden', 'Only owners and managers can manage coupons.');
        }
    }

    /** @return array<string, mixed> */
    private function input(Request $request, bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';
        $nullableInt = fn (int $min, int $max) => ['sometimes', 'nullable', 'integer:strict', "min:{$min}", "max:{$max}"];

        return $request->validate([
            'revision' => $create ? ['prohibited'] : ['required', 'integer:strict'],
            'code' => [$req, 'string', 'max:32'],
            'type' => [$req, 'string', Rule::in(Coupon::TYPES)],
            'percent_bps' => $nullableInt(1, 10000),
            'amount' => $nullableInt(1, 1_000_000_000),
            'max_discount_amount' => $nullableInt(1, 1_000_000_000),
            'applies_to' => ['sometimes', 'string', 'in:all,categories,products'],
            'category_ids' => ['sometimes', 'nullable', 'array', 'max:100'],
            'category_ids.*' => ['string', 'distinct'],
            'product_ids' => ['sometimes', 'nullable', 'array', 'max:100'],
            'product_ids.*' => ['string', 'distinct'],
            'min_subtotal_amount' => $nullableInt(0, 1_000_000_000),
            'usage_limit' => $nullableInt(1, 1_000_000),
            'usage_per_customer' => $nullableInt(1, 1000),
            'first_order_only' => ['sometimes', 'boolean:strict'],
            'starts_at' => ['sometimes', 'nullable', 'date'],
            'ends_at' => ['sometimes', 'nullable', 'date'],
            'status' => ['sometimes', 'string', Rule::in(Coupon::STATUSES)],
        ]);
    }

    private function one(Coupon $coupon, int $status = 200): JsonResponse
    {
        $coupon = Coupon::query()->whereKey($coupon->id)->with(CouponPresenter::with())->firstOrFail();

        return new JsonResponse(['data' => CouponPresenter::present($coupon)], $status);
    }
}
