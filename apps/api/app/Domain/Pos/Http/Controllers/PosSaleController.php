<?php

declare(strict_types=1);

namespace App\Domain\Pos\Http\Controllers;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\CouponValidator;
use App\Domain\Customers\Models\Customer;
use App\Domain\Orders\OrderPresenter;
use App\Domain\Pos\Http\Requests\PosPlanGate;
use App\Domain\Pos\Http\Requests\PosQuoteRequest;
use App\Domain\Pos\Http\Requests\PosSaleRequest;
use App\Domain\Pos\Models\PosRegister;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\PosPresenter;
use App\Domain\Pos\PosPricing;
use App\Domain\Pos\PosSaleService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-8D §5, §7, §10: catalog and scan lookup at the register location, customer lookup by exact phone, quote,
 * sale, sale detail (receipt) and the SMS receipt. Every route `pos.sell`; plan `pos` on quote, sale and SMS (402).
 */
class PosSaleController
{
    public const CATALOG_PER_PAGE = 40;

    private const NO_STORE = ['Cache-Control' => 'private, no-store'];

    public function __construct(
        private readonly PosSaleService $sales,
        private readonly PosPricing $pricing,
        private readonly TenantContext $context,
    ) {}

    /** Active products by name (40 per page), enabled variants, `available` at the register location (§5.3). */
    public function catalog(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'register_id' => ['required', 'string', 'size:26'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'filter' => ['sometimes', 'array:category_id'],
            'filter.category_id' => ['sometimes', 'string', 'size:26'],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $register = self::register($store, $input['register_id']);
        $query = Product::query()->where('store_id', $store->id)->where('status', Product::ACTIVE);
        $q = trim((string) ($input['q'] ?? ''));
        if ($q !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($q)).'%';
            $query->where(fn (Builder $w) => $w->whereRaw("lower(name) like ? escape '\\'", [$like])
                ->orWhereExists(fn ($v) => $v->selectRaw('1')->from('product_variants')->whereColumn('product_variants.product_id', 'products.id')
                    ->whereNull('product_variants.deleted_at')
                    ->where(fn ($c) => $c->whereRaw("lower(product_variants.sku) like ? escape '\\'", [$like])->orWhereRaw("lower(product_variants.barcode) like ? escape '\\'", [$like]))));
        }
        if (isset($input['filter']['category_id'])) {
            $categories = CouponValidator::withDescendants($store->id, [strtolower($input['filter']['category_id'])]);
            $query->whereExists(fn ($pc) => $pc->selectRaw('1')->from('product_categories')->whereColumn('product_categories.product_id', 'products.id')
                ->whereIn('product_categories.category_id', $categories));
        }
        $page = $query->with(['variants' => fn ($v) => $v->orderBy('position')->orderBy('id'), 'images.media'])
            ->orderBy('name')->orderBy('id')
            ->cursorPaginate(self::CATALOG_PER_PAGE, ['*'], 'cursor', $input['cursor'] ?? null);
        $products = collect($page->items());
        $variantIds = $products->flatMap(fn (Product $p) => $p->variants->pluck('id'))->values()->all();
        $available = PosPricing::availableAt($store->id, $register->location_id, $variantIds);
        $currency = $store->currency ?: 'BDT';

        return new JsonResponse([
            'data' => $products->map(fn (Product $p) => PosPresenter::catalogItem($p, $available, $currency))->values()->all(),
            'meta' => [
                'next_cursor' => $page->nextCursor()?->encode(),
                'prev_cursor' => $page->previousCursor()?->encode(),
                'per_page' => $page->perPage(),
            ],
        ], 200, self::NO_STORE);
    }

    /** Exact, case-insensitive SKU then barcode (≤ 64 chars; no wildcards) → one variant, else 404 `pos_code_not_found`. */
    public function lookup(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate([
            'register_id' => ['required', 'string', 'size:26'],
            'code' => ['required', 'string', 'max:64'],
        ]);
        $register = self::register($store, $input['register_id']);
        $code = trim($input['code']);
        $base = fn () => ProductVariant::query()->where('product_variants.store_id', $store->id)->where('product_variants.is_enabled', true)
            ->whereHas('product', fn ($p) => $p->where('status', Product::ACTIVE));
        $variant = $code === '' ? null
            : ($base()->whereRaw('lower(product_variants.sku) = ?', [mb_strtolower($code)])->orderBy('id')->first()
                ?? $base()->whereRaw('lower(product_variants.barcode) = ?', [mb_strtolower($code)])->orderBy('id')->first());
        if ($variant === null) {
            throw new ApiException(404, 'pos_code_not_found', 'No product has that SKU or barcode.', ['code' => $input['code']]);
        }
        /** @var Product $product */
        $product = Product::query()->whereKey($variant->product_id)->with(['variants', 'images.media'])->firstOrFail();
        $available = PosPricing::availableAt($store->id, $register->location_id, [$variant->id]);

        return new JsonResponse(['data' => PosPresenter::catalogItem($product, $available, $store->currency ?: 'BDT', $variant->id)], 200, self::NO_STORE);
    }

    /** Exact normalised phone → OrderCustomerSummary, else 404 (S203: no partial search, same queries for hit and miss). */
    public function customer(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate(['phone' => ['required', 'string', 'max:20']]);
        $phone = Phone::bdMsisdn($input['phone']);
        $customer = Customer::query()->where('store_id', $store->id)->where('phone', $phone ?? '')->first();
        if ($phone === null || $customer === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return new JsonResponse(['data' => OrderPresenter::customerSummary($customer, null)], 200, self::NO_STORE);
    }

    public function quote(PosQuoteRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        $session = PosSaleService::openSession($store, $input['session_id']);
        $phone = isset($input['customer_phone']) ? Phone::bdMsisdn($input['customer_phone']) : null;
        $quote = $this->pricing->quote($store->id, $session->location_id, $session->currency, $input['lines'], $input['coupon_code'] ?? null, $phone);

        return new JsonResponse(['data' => $quote], 200, self::NO_STORE);
    }

    public function store(PosSaleRequest $request, Store $store): JsonResponse
    {
        $input = $request->validated();
        if (isset($input['customer']['phone'])) {
            $input['customer']['phone'] = Phone::bdMsisdn($input['customer']['phone']);
        }
        $sale = $this->sales->sell($store, $input, $request->user(), (string) $request->header(IdempotencyGuard::HEADER) ?: null);

        return $this->sale($store, $sale, 201);
    }

    public function show(Store $store, string $sale): JsonResponse
    {
        return $this->sale($store, self::findSale($store, $sale));
    }

    public function smsReceipt(Store $store, string $sale): JsonResponse
    {
        $row = self::findSale($store, $sale);
        PosPlanGate::assert();

        return $this->sale($store, $this->sales->resendReceipt($row));
    }

    public static function findSale(Store $store, string $id): PosSale
    {
        return PosSale::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** `register_id` of a catalog / lookup query: this store's register, else 422 (foreign-id rule, S195). */
    private static function register(Store $store, string $id): PosRegister
    {
        return PosRegister::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first()
            ?? throw ValidationException::withMessages(['register_id' => ['Unknown register.']]);
    }

    private function sale(Store $store, PosSale $sale, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => PosPresenter::sale($sale, $store, $this->context->permissions())], $status, self::NO_STORE);
    }
}
