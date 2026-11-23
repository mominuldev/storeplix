<?php

namespace App\Domain\Dashboard\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Support\StockSql;
use App\Domain\Customers\Http\Controllers\CustomerController;
use App\Domain\Customers\Models\Customer;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;

/** §3.6 GET /stores/{store}/dashboard — read model from plain aggregates. Phase 5 §3.9 fills the `orders` block. */
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
                'stock_value_cost_amount' => $context->allows(Permission::CostsView) ? (int) $stock->value_cost : null,
            ],
            'customers' => [
                'total' => Customer::query()->where('store_id', $store->id)->count(),
                'new_this_month' => Customer::query()->where('store_id', $store->id)->where('created_at', '>=', CustomerController::monthStart($store))->count(),
            ],
            'orders' => $this->orders($store, $tenant),
            'setup' => ['has_products' => $total > 0],
        ]], 200, ['Cache-Control' => 'no-store']);
    }

    /** OrderDashboard (§3.9): this month in the store timezone; null until the first order. */
    private function orders(Store $store, Tenant $tenant): ?array
    {
        if (! Order::query()->where('store_id', $store->id)->exists()) {
            return null;
        }
        $since = CustomerController::monthStart($store);
        $count = fn (string $column, ?string $status = null) => Order::query()->where('store_id', $store->id)
            ->where($column, '>=', $since)->when($status, fn ($q) => $q->where('status', $status))->count();
        $delivered = $count('delivered_at', Order::DELIVERED);
        $returned = $count('returned_at', Order::RETURNED);
        $waiting = Order::query()->where('store_id', $store->id)->whereIn('status', [Order::PENDING_PAYMENT, Order::PENDING, Order::CONFIRMED, Order::READY_TO_SHIP])
            ->groupBy('status')->selectRaw('status, count(*) as aggregate')->pluck('aggregate', 'status');

        $best = DB::table('order_items')->join('orders', 'orders.id', '=', 'order_items.order_id')
            ->where('orders.tenant_id', $tenant->id)->where('orders.store_id', $store->id)
            ->where('orders.status', '<>', Order::CANCELLED)->where('orders.placed_at', '>=', now()->subDays(30))
            ->whereNotNull('order_items.product_id')
            ->groupBy('order_items.product_id')
            ->selectRaw('order_items.product_id as product_id, sum(order_items.quantity) as units, max(order_items.product_name) as name')
            ->orderByDesc('units')->orderBy('order_items.product_id')->limit(5)->get();
        $products = Product::withTrashed()->whereIn('id', $best->pluck('product_id')->all())->with('images.media')->get()->keyBy('id');

        return [
            'this_month' => [
                'count' => $count('placed_at'),
                'sales_amount' => (int) Order::query()->where('store_id', $store->id)->where('status', Order::DELIVERED)
                    ->where('delivered_at', '>=', $since)->sum('total_amount'),
                'delivered_count' => $delivered,
                'returned_count' => $returned,
                'cancelled_count' => $count('cancelled_at', Order::CANCELLED),
                'delivery_success_rate' => $delivered + $returned > 0 ? round($delivered / ($delivered + $returned), 4) : null,
            ],
            'waiting' => [
                'pending' => (int) ($waiting[Order::PENDING] ?? 0),
                'confirmed' => (int) ($waiting[Order::CONFIRMED] ?? 0),
                'ready_to_ship' => (int) ($waiting[Order::READY_TO_SHIP] ?? 0),
                // 5b-2: unpaid online orders inside their 30-minute hold
                'pending_payment' => (int) ($waiting[Order::PENDING_PAYMENT] ?? 0),
                // 5b-3: confirmed / ready_to_ship orders with no active shipment ("Needs you today")
                'to_book' => Order::query()->where('store_id', $store->id)->whereIn('status', [Order::CONFIRMED, Order::READY_TO_SHIP])
                    ->whereNotExists(fn ($q) => $q->selectRaw('1')->from('shipments')->whereColumn('shipments.order_id', 'orders.id')
                        ->whereNotIn('shipments.status', ['cancelled', 'booking_failed']))->count(),
            ],
            // 5b-3: active shipments the courier flagged (delivery_failed, on_hold, returning, unknown)
            'shipments' => [
                'problems' => Shipment::query()->where('store_id', $store->id)->whereNotNull('problem')
                    ->whereNotIn('status', Shipment::FINAL_STATUSES)->count(),
            ],
            'best_sellers' => $best->map(fn ($row) => [
                'product_id' => $row->product_id,
                'name' => $products[$row->product_id]->name ?? $row->name,
                'image' => MediaPresenter::ref(($products[$row->product_id] ?? null)?->images->first()?->media),
                'units' => (int) $row->units,
            ])->all(),
            'plan' => [
                'used' => FeatureGate::usage($tenant, Limit::OrdersPerMonth),
                'limit' => FeatureGate::limit($tenant, Limit::OrdersPerMonth),
            ],
        ];
    }
}
