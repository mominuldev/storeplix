<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Http\Controllers\InventoryController;
use App\Domain\Inventory\Http\Resources\InventoryPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-4 §3 external stock: list with `sku` / `updated_since` filters (merchant `InventoryItem` shape) and
 * adjustments through the merchant controller (InventoryService ledger, reason required; the route requires an
 * Idempotency-Key). The movement's actor is the key (`actor_api_key_id`).
 */
class ExternalInventoryController
{
    use ExternalLists;

    public function __construct(private readonly TenantContext $context) {}

    /**
     * Merchant list (`InventoryItem`, `InventoryListMeta`); `filter[sku]` (exact, comma list ≤ 100) and
     * `filter[updated_since]` (stock row changed since; `updated_at` ascending) are external only.
     */
    public function index(Request $request, Store $store): JsonResponse
    {
        $merchant = fn (Request $r) => app(InventoryController::class)->index($r, $store);
        $external = self::externalFilters($request, ['sku', 'updated_since']);
        if ($external === []) {
            return $merchant($request);
        }
        $input = $request->validate([
            'filter.sku' => ['sometimes', 'string', 'max:2000'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $since = self::updatedSince($request);
        $meta = self::metaOf(self::merchantList($request, ['sku', 'updated_since'], $merchant, metaOnly: true));

        $query = ProductVariant::query()
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->join('inventories', 'inventories.variant_id', '=', 'product_variants.id')
            ->where('product_variants.store_id', $store->id)
            ->whereNull('products.deleted_at')
            ->select('product_variants.*');
        if (isset($input['filter']['sku'])) {
            $skus = array_values(array_filter(array_map('trim', explode(',', $input['filter']['sku'])), fn ($s) => $s !== ''));
            $query->whereIn('product_variants.sku', array_slice($skus, 0, 100));
        }
        if ($since !== null) {
            $query->where('inventories.updated_at', '>=', $since)->orderBy('inventories.updated_at');
        }
        $query->orderBy('products.name')->orderBy('products.id')->orderBy('product_variants.position');

        $page = $query->with(['inventory', 'product.images.media'])->paginate((int) ($input['per_page'] ?? 25));
        $costs = $this->context->allows(Permission::CostsView);

        return self::page($page, $page->getCollection()->map(fn (ProductVariant $v) => InventoryPresenter::item($v, $costs))->all(), $meta);
    }

    public function adjust(Request $request, Store $store): JsonResponse
    {
        return app(InventoryController::class)->adjust($request, $store);
    }
}
