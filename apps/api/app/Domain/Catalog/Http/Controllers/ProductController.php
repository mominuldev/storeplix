<?php

namespace App\Domain\Catalog\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Catalog\Http\Requests\ProductRequest;
use App\Domain\Catalog\Http\Resources\ProductPresenter;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\ProductPayloadValidator;
use App\Domain\Catalog\ProductService;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Inventory\InventorySql;
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

/** §3.2 products. */
class ProductController
{
    public const SORTS = ['-created_at', 'created_at', 'name', '-name', 'price', '-price', '-updated_at'];

    public function __construct(
        private readonly ProductService $products,
        private readonly TenantContext $context,
    ) {}

    /** GET /stores/{store}/products */
    public function index(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status,category_id,stock'],
            'filter.status' => ['sometimes', 'string', 'regex:/^(draft|active|archived)(,(draft|active|archived))*$/'],
            'filter.category_id' => ['sometimes', 'string', 'size:26'],
            'filter.stock' => ['sometimes', 'string', 'in:in,low,out'],
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'sort' => ['sometimes', 'string', Rule::in(self::SORTS)],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);

        $query = self::filtered($store, $input['filter'] ?? [], trim((string) ($input['q'] ?? '')));
        match ($input['sort'] ?? '-created_at') {
            'created_at' => $query->orderBy('created_at')->orderBy('id'),
            'name' => $query->orderBy('name')->orderBy('id'),
            '-name' => $query->orderByDesc('name')->orderByDesc('id'),
            'price' => $query->orderBy('price_min_amount')->orderBy('id'),
            '-price' => $query->orderByDesc('price_min_amount')->orderByDesc('id'),
            '-updated_at' => $query->orderByDesc('updated_at')->orderByDesc('id'),
            default => $query->orderByDesc('created_at')->orderByDesc('id'),
        };

        $paginator = $query->with(ProductPresenter::with())->paginate((int) ($input['per_page'] ?? 25));
        $costs = $this->costs();

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (Product $p) => ProductPresenter::summary($p, $costs))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
                'counts' => $this->counts($store),
                'summary' => $this->summary($store),
                'plan' => [
                    'limit' => FeatureGate::limit($this->context->tenant(), Limit::Products),
                    'used' => FeatureGate::usage($this->context->tenant(), Limit::Products),
                ],
            ],
        ]);
    }

    public function store(ProductRequest $request, Store $store): JsonResponse
    {
        $plan = ProductPayloadValidator::normalise($store, null, $request->productInput(), $this->costs());
        $product = $this->products->create($store, $plan, $request->user());

        return $this->one($product, 201);
    }

    public function show(Store $store, Product $product): JsonResponse
    {
        Gate::authorize('view', $product);

        return $this->one($product);
    }

    public function update(ProductRequest $request, Store $store, Product $product): JsonResponse
    {
        Gate::authorize('update', $product);
        $input = $request->productInput();
        $plan = ProductPayloadValidator::normalise($store, $product, $input, $this->costs());

        return $this->one($this->products->update($store, $product, $plan, (int) $input['revision'], $request->user()));
    }

    public function destroy(Store $store, Product $product): Response
    {
        Gate::authorize('delete', $product);
        $this->products->delete($product);

        return response()->noContent();
    }

    public function duplicate(Request $request, Store $store, Product $product): JsonResponse
    {
        Gate::authorize('update', $product);

        return $this->one($this->products->duplicate($store, $product, $request->user()), 201);
    }

    /** POST /stores/{store}/products/bulk */
    public function bulk(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'action' => ['required', 'string', 'in:activate,draft,archive,delete,set_categories,add_categories'],
            'ids' => ['required', 'array', 'min:1', 'max:100'],
            'ids.*' => ['required', 'string', 'distinct'],
            'category_ids' => ['required_if:action,set_categories,add_categories', 'array', 'max:'.Product::MAX_CATEGORIES],
            'category_ids.*' => ['string', 'distinct', Rule::exists('categories', 'id')
                ->where('tenant_id', $this->context->requireId())->where('store_id', $store->id)->whereNull('deleted_at')],
        ], ['category_ids.*.exists' => 'Unknown category.']);

        if ($input['action'] === 'delete' && ! $this->context->allows(Permission::ProductsDelete)) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to delete products.');
        }

        $ids = array_map('strtolower', $input['ids']);
        $known = Product::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('id')->flip();
        $errors = [];
        foreach ($ids as $i => $id) {
            if (! isset($known[$id])) {
                $errors["ids.{$i}"] = ['Unknown product.'];
            }
        }
        if ($errors !== []) {
            throw new ApiException(422, 'validation_failed', 'The given data was invalid.', $errors);
        }

        $updated = $this->products->bulk($store, $input['action'], $ids, array_map('strtolower', $input['category_ids'] ?? []), $request->user());

        return new JsonResponse(['data' => ['action' => $input['action'], 'updated' => $updated]]);
    }

    /**
     * Shared by the list and products export: status / category / stock / q filters.
     *
     * @param  array<string, string>  $filter
     */
    public static function filtered(Store $store, array $filter, string $q): Builder
    {
        $query = Product::query()->where('products.store_id', $store->id);
        if (isset($filter['status'])) {
            $query->whereIn('status', explode(',', $filter['status']));
        }
        if (isset($filter['category_id'])) {
            $query->whereExists(fn ($sub) => $sub->select(DB::raw(1))->from('product_categories')
                ->whereColumn('product_categories.product_id', 'products.id')
                ->where('product_categories.category_id', strtolower($filter['category_id'])));
        }
        if (isset($filter['stock'])) {
            // PHASE-8-8C §5.3: TOTAL reader (Σ over non-archived locations).
            $exists = fn (string $status) => fn ($sub) => InventorySql::joinTotals($sub->select(DB::raw(1))->from('product_variants'), $store->id)
                ->whereColumn('product_variants.product_id', 'products.id')
                ->whereNull('product_variants.deleted_at')
                ->whereRaw(StockSql::condition($status));
            match ($filter['stock']) {
                'out' => $query->whereExists($exists('out')),
                'low' => $query->whereExists($exists('low')),
                'in' => $query->whereNotExists($exists('out'))->whereNotExists($exists('low')),
            };
        }
        if ($q !== '') {
            $like = StockSql::contains($q);
            $op = StockSql::like();
            $query->where(fn ($w) => $w->where('products.name', $op, $like)
                ->orWhereExists(fn ($sub) => $sub->select(DB::raw(1))->from('product_variants')
                    ->whereColumn('product_variants.product_id', 'products.id')
                    ->whereNull('product_variants.deleted_at')
                    ->where(fn ($v) => $v->where('product_variants.sku', $op, $like)->orWhere('product_variants.barcode', $op, $like))));
        }

        return $query;
    }

    /** @return array<string, int> */
    private function counts(Store $store): array
    {
        $byStatus = Product::query()->where('store_id', $store->id)->groupBy('status')
            ->selectRaw('status, count(*) as aggregate')->pluck('aggregate', 'status');
        $counts = ['all' => (int) $byStatus->sum()];
        foreach (Product::STATUSES as $status) {
            $counts[$status] = (int) ($byStatus[$status] ?? 0);
        }

        return $counts;
    }

    /** Active products, their enabled variants, and low/out among tracked enabled variants of active products. */
    private function summary(Store $store): array
    {
        $base = InventorySql::joinTotals(DB::table('product_variants')
            ->join('products', 'products.id', '=', 'product_variants.product_id'), $store->id) // TOTAL reader (PHASE-8-8C §5.3)
            ->where('products.tenant_id', $this->context->requireId())
            ->where('products.store_id', $store->id)
            ->whereNull('products.deleted_at')->whereNull('product_variants.deleted_at')
            ->where('products.status', Product::ACTIVE)
            ->where('product_variants.is_enabled', true);

        return [
            'active_products' => Product::query()->where('store_id', $store->id)->where('status', Product::ACTIVE)->count(),
            'active_variants' => (clone $base)->count(),
            'low_stock_variants' => (clone $base)->whereRaw(StockSql::condition('low'))->count(),
            'out_of_stock_variants' => (clone $base)->whereRaw(StockSql::condition('out'))->count(),
        ];
    }

    private function costs(): bool
    {
        return $this->context->allows(Permission::CostsView);
    }

    private function one(Product $product, int $status = 200): JsonResponse
    {
        $product = Product::query()->whereKey($product->id)->with(ProductPresenter::with(true))->firstOrFail();

        return new JsonResponse(['data' => ProductPresenter::full($product, $this->costs())], $status);
    }
}
