<?php

namespace App\Domain\Dashboard\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Customers\Http\Controllers\CustomerController;
use App\Domain\Customers\Models\Customer;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

/** §3.6 GET /stores/{store}/dashboard — read model from plain aggregates. Orders/money are null until Phase 5. */
class DashboardController
{
    public function __invoke(Store $store, TenantContext $context): JsonResponse
    {
        Gate::authorize('view', $store);
        $tenant = $context->tenant();

        $byStatus = Product::query()->where('store_id', $store->id)->groupBy('status')
            ->selectRaw('status, count(*) as aggregate')->pluck('aggregate', 'status');
        $total = (int) $byStatus->sum();

        $onHand = 'CASE WHEN inventories.on_hand > 0 THEN inventories.on_hand ELSE 0 END';
        $stock = DB::table('product_variants')
            ->join('products', 'products.id', '=', 'product_variants.product_id')
            ->join('inventories', 'inventories.variant_id', '=', 'product_variants.id')
            ->where('products.tenant_id', $context->requireId())
            ->where('products.store_id', $store->id)
            ->whereNull('products.deleted_at')->whereNull('product_variants.deleted_at')
            ->where('products.status', Product::ACTIVE)
            ->where('product_variants.is_enabled', true)
            ->where('product_variants.track_inventory', true)
            ->selectRaw(implode(', ', [
                'coalesce(sum(CASE WHEN '.StockSql::condition('low').' THEN 1 ELSE 0 END), 0) as low_count',
                'coalesce(sum(CASE WHEN '.StockSql::condition('out').' THEN 1 ELSE 0 END), 0) as out_count',
                "coalesce(sum({$onHand}), 0) as units",
                "coalesce(sum(CASE WHEN product_variants.cost_amount IS NOT NULL THEN {$onHand} * product_variants.cost_amount ELSE 0 END), 0) as value_cost",
            ]))->first();

        return new JsonResponse(['data' => [
            'currency' => $store->currency ?: 'BDT',
            'timezone' => $store->timezone ?: 'Asia/Dhaka',
            'generated_at' => now()->toIso8601ZuluString(),
            'products' => [
                'total' => $total,
                'active' => (int) ($byStatus[Product::ACTIVE] ?? 0),
                'draft' => (int) ($byStatus[Product::DRAFT] ?? 0),
                'archived' => (int) ($byStatus[Product::ARCHIVED] ?? 0),
                'limit' => FeatureGate::limit($tenant, Limit::Products),
            ],
            'inventory' => [
                'low_stock_variants' => (int) $stock->low_count,
                'out_of_stock_variants' => (int) $stock->out_count,
                'units_on_hand' => (int) $stock->units,
                'stock_value_cost_amount' => Permission::ViewCosts->grantedTo($context->role()) ? (int) $stock->value_cost : null,
            ],
            'customers' => [
                'total' => Customer::query()->where('store_id', $store->id)->count(),
                'new_this_month' => Customer::query()->where('store_id', $store->id)->where('created_at', '>=', CustomerController::monthStart($store))->count(),
            ],
            'orders' => null,
            'setup' => ['has_products' => $total > 0],
        ]], 200, ['Cache-Control' => 'no-store']);
    }
}
