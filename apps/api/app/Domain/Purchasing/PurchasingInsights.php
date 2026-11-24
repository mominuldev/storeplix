<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Read-only purchasing numbers: the supplier KPI tiles (§6.1), the PO KPI tiles (§6.2) and reorder suggestions (§7).
 * Computed on request from the store's own rows; nothing here writes.
 */
final class PurchasingInsights
{
    public const SUGGESTIONS_MAX = 50;

    /** @return array<string, mixed> SupplierSummary */
    public static function supplierSummary(Store $store): array
    {
        $today = PurchaseHistory::today($store);
        $week = CarbonImmutable::parse($today)->addDays(7)->format('Y-m-d');
        $monthStart = PurchaseHistory::monthStart($store);
        // Review L3: every supplier (archived ones too), so "You owe" equals the PO page's "Owed to suppliers".
        $ids = Supplier::query()->where('store_id', $store->id)->pluck('id')->all();
        $activeIds = Supplier::query()->where('store_id', $store->id)->whereNull('archived_at')->pluck('id')->all();
        $stats = SupplierStats::forIds($store, $ids);
        $open = self::pos($store)->whereIn('status', PurchaseOrder::OPEN);

        return [
            'currency' => $store->currency ?: 'BDT',
            'suppliers_count' => count($activeIds),
            'active_this_month' => count(array_filter(array_intersect_key($stats, array_flip($activeIds)), fn ($s) => $s['active_this_month'])),
            'owed_amount' => array_sum(array_map(fn ($s) => max(0, $s['owed_amount']), $stats)),
            'owed_suppliers_count' => count(array_filter($stats, fn ($s) => $s['owed_amount'] > 0)),
            'overdue_count' => count(array_filter($stats, fn ($s) => $s['overdue_amount'] > 0)),
            'pos_on_the_way' => (clone $open)->count(),
            'arriving_this_week' => (clone $open)->whereNotNull('expected_on')->whereBetween('expected_on', [$today, $week])->count(),
            'bought_this_month_amount' => (int) DB::table('purchase_receipts')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)
                ->where('received_at', '>=', $monthStart)->sum('value_amount'),
        ];
    }

    /** @return array<string, mixed> PurchaseOrderSummary */
    public static function orderSummary(Store $store): array
    {
        $today = PurchaseHistory::today($store);
        $week = CarbonImmutable::parse($today)->addDays(7)->format('Y-m-d');
        $open = self::pos($store)->whereIn('status', PurchaseOrder::OPEN);
        $openRow = (clone $open)->selectRaw('count(*) as n, coalesce(sum(total_amount), 0) as total, count(distinct supplier_id) as suppliers')->first();
        $units = (int) DB::table('purchase_order_items as i')->join('purchase_orders as po', 'po.id', '=', 'i.purchase_order_id')
            ->where('i.tenant_id', $store->tenant_id)->where('i.store_id', $store->id)->whereIn('po.status', PurchaseOrder::OPEN)
            ->sum(DB::raw('CASE WHEN i.quantity_ordered - i.quantity_received - i.quantity_damaged > 0 THEN i.quantity_ordered - i.quantity_received - i.quantity_damaged ELSE 0 END'));
        $supplierIds = Supplier::query()->where('store_id', $store->id)->pluck('id')->all();
        $owed = array_sum(array_map(fn ($s) => max(0, $s['owed_amount']), SupplierStats::forIds($store, $supplierIds)));
        $late = (clone $open)->whereNotNull('expected_on')->where('expected_on', '<', $today)->orderBy('expected_on')->orderBy('sequence')->get(['id', 'number', 'expected_on']);
        $first = $late->first();

        return [
            'currency' => $store->currency ?: 'BDT',
            'open_count' => (int) $openRow->n,
            'open_total_amount' => (int) $openRow->total,
            'units_coming' => $units,
            'suppliers_coming' => (int) $openRow->suppliers,
            'owed_amount' => $owed,
            'payments_due_this_week' => self::pos($store)->where('status', '<>', PurchaseOrder::CANCELLED)->whereNotNull('due_on')
                ->whereBetween('due_on', [$today, $week])->whereRaw('received_value_amount - paid_amount > 0')->count(),
            'late_count' => $late->count(),
            'first_late' => $first === null ? null : [
                'id' => $first->id,
                'number' => $first->number,
                'days_late' => (int) CarbonImmutable::parse(substr((string) $first->expected_on, 0, 10))->diffInDays(CarbonImmutable::parse($today)),
            ],
        ];
    }

    /**
     * §7: tracked variants of active products that sold in the last 30 days (`order_shipped` movements) and will run out
     * within the lead time + 7 days. Grouped by last supplier (null = "No supplier yet"), sorted by days left, ≤ 50.
     *
     * @return list<array<string, mixed>> ReorderSuggestionGroup[]
     */
    public static function reorderSuggestions(Store $store): array
    {
        $sold = DB::table('inventory_movements')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)
            ->where('reason', 'order_shipped')->where('created_at', '>=', now()->subDays(30))
            ->groupBy('variant_id')->selectRaw('variant_id, sum(-delta) as units')->pluck('units', 'variant_id')
            ->map(fn ($v) => (int) $v)->filter(fn (int $v) => $v > 0)->all();
        if ($sold === []) {
            return [];
        }

        $variants = ProductVariant::query()->where('store_id', $store->id)->whereIn('id', array_keys($sold))->where('track_inventory', true)
            ->whereHas('product', fn ($q) => $q->where('status', Product::ACTIVE))
            ->with(['inventory', 'product.images.media'])->get()->keyBy('id');
        $incoming = PurchaseHistory::incoming($store, $variants->keys()->all());
        $last = PurchaseHistory::lastUnitCosts($store, $variants->keys()->all());
        $suppliers = Supplier::query()->where('store_id', $store->id)->whereIn('id', array_values(array_unique(array_column($last, 'supplier_id'))))->get()->keyBy('id');

        $items = [];
        foreach ($variants as $id => $variant) {
            $units = $sold[$id];
            $available = (int) (($variant->inventory?->on_hand ?? 0) - ($variant->inventory?->committed ?? 0));
            $coming = $incoming[$id] ?? 0;
            $daysLeft = max(0, intdiv(max(0, $available + $coming) * 30, $units)); // floor((available + incoming) ÷ (units ÷ 30))
            $supplier = isset($last[$id]) ? $suppliers->get($last[$id]['supplier_id']) : null;
            $lead = $supplier?->lead_time_days ?? 7;
            if ($daysLeft > $lead + 7) {
                continue;
            }
            $product = $variant->product;
            $cover = $product->images->first();
            $items[] = [
                'supplier' => $supplier,
                'item' => [
                    'variant_id' => $id,
                    'product' => ['id' => $product->id, 'name' => $product->name, 'image' => MediaPresenter::ref($cover?->media)],
                    'variant_title' => (string) $variant->title,
                    'sku' => $variant->sku,
                    'available' => $available,
                    'incoming' => $coming,
                    'sold_30d' => $units,
                    'days_left' => $daysLeft,
                    'suggested_quantity' => max(1, $units - $available - $coming), // ceil(daily × 30) = units
                    'last_unit_cost_amount' => $last[$id]['unit_cost'] ?? null,
                ],
            ];
        }
        usort($items, fn ($a, $b) => [$a['item']['days_left'], $a['item']['product']['name']] <=> [$b['item']['days_left'], $b['item']['product']['name']]);
        $items = array_slice($items, 0, self::SUGGESTIONS_MAX);

        $groups = [];
        foreach ($items as ['supplier' => $supplier, 'item' => $item]) {
            $key = $supplier?->id ?? '';
            $groups[$key] ??= [
                'supplier' => $supplier === null ? null : ['id' => $supplier->id, 'name' => $supplier->name, 'lead_time_days' => $supplier->lead_time_days],
                'items' => [],
            ];
            $groups[$key]['items'][] = $item;
        }

        return array_values($groups);
    }

    private static function pos(Store $store): Builder
    {
        return DB::table('purchase_orders')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id);
    }
}
