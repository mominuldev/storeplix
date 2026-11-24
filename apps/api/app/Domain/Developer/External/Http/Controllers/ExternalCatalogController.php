<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use App\Domain\Catalog\Http\Controllers\CategoryController;
use App\Domain\Catalog\Http\Controllers\ProductController;
use App\Domain\Catalog\Http\Resources\ProductPresenter;
use App\Domain\Catalog\Models\Product;
use App\Domain\Developer\External\Http\Requests\ExternalProductRequest;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-4 §3 external products and categories: thin delegation to the merchant controllers (same validation,
 * services, plan product limit, audit, response shapes). Costs appear only for keys created with `include_costs`.
 * Delete is not exposed (Q128).
 */
class ExternalCatalogController
{
    use ExternalLists;

    public function __construct(private readonly TenantContext $context) {}

    /** Merchant list (`q`, filters, `ProductListMeta`); `filter[updated_since]` pages by `updated_at` ascending. */
    public function products(Request $request, Store $store): JsonResponse
    {
        $merchant = fn (Request $r) => app(ProductController::class)->index($r, $store);
        $since = self::updatedSince($request);
        if ($since === null) {
            return $merchant($request);
        }
        $request->validate(['page' => ['sometimes', 'integer', 'min:1'], 'per_page' => ['sometimes', 'integer', 'min:1', 'max:100']]);
        $meta = self::metaOf(self::merchantList($request, ['updated_since'], $merchant, metaOnly: true));

        $filter = array_diff_key((array) $request->query('filter', []), ['updated_since' => true]);
        $page = ProductController::filtered($store, $filter, trim((string) $request->query('q', '')))
            ->where('products.updated_at', '>=', $since)
            ->orderBy('products.updated_at')->orderBy('products.id')
            ->with(ProductPresenter::with())
            ->paginate((int) $request->query('per_page', 25));
        $costs = $this->context->allows(Permission::CostsView);

        return self::page($page, $page->getCollection()->map(fn (Product $p) => ProductPresenter::summary($p, $costs))->all(), $meta);
    }

    public function product(Store $store, Product $product): JsonResponse
    {
        return app(ProductController::class)->show($store, $product);
    }

    public function storeProduct(ExternalProductRequest $request, Store $store): JsonResponse
    {
        return app(ProductController::class)->store($request, $store);
    }

    public function updateProduct(ExternalProductRequest $request, Store $store, Product $product): JsonResponse
    {
        return app(ProductController::class)->update($request, $store, $product);
    }

    public function categories(Request $request, Store $store): JsonResponse
    {
        return app(CategoryController::class)->index($request, $store);
    }
}
