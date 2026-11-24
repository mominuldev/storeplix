<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Stores\Models\Store;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Derived supplier numbers (PHASE-8-8B §4, §6, P88B-8/9, Q209), computed on request:
 * owed = Σ received value of its non-cancelled POs − Σ all its payments (negative = credit);
 * overdue = Σ balance (received value − linked payments) of POs whose due_on is before today, capped at owed;
 * overdue_since = the earliest such due_on.
 */
final class SupplierStats
{
    /** SQL: Σ received value of the supplier's non-cancelled POs − Σ its payments (for `sort=-owed_amount`). */
    public static function owedSql(string $supplierColumn = 'suppliers.id'): string
    {
        return "(coalesce((SELECT sum(po.received_value_amount) FROM purchase_orders po WHERE po.supplier_id = {$supplierColumn} AND po.status <> 'cancelled'), 0)"
            ." - coalesce((SELECT sum(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id = {$supplierColumn}), 0))";
    }

    public static function lastOrderSql(string $supplierColumn = 'suppliers.id'): string
    {
        return "(SELECT max(po.created_at) FROM purchase_orders po WHERE po.supplier_id = {$supplierColumn})";
    }

    /**
     * @param  list<string>  $ids
     * @return array<string, array{products_count: int, open_pos_count: int, past_orders_count: int, owed_amount: int, overdue_amount: int, overdue_since: string|null, last_order_on: string|null, active_this_month: bool}>
     */
    public static function forIds(Store $store, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $today = PurchaseHistory::today($store);
        $monthStart = PurchaseHistory::monthStart($store);
        $pos = fn (): Builder => DB::table('purchase_orders')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)->whereIn('supplier_id', $ids);

        $orders = $pos()->groupBy('supplier_id')->selectRaw(implode(', ', [
            'supplier_id',
            "sum(CASE WHEN status IN ('ordered','partially_received') THEN 1 ELSE 0 END) as open_count",
            "sum(CASE WHEN status NOT IN ('draft','cancelled') THEN 1 ELSE 0 END) as past_count",
            "coalesce(sum(CASE WHEN status <> 'cancelled' THEN received_value_amount ELSE 0 END), 0) as received",
            'max(created_at) as last_order_at',
            'sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as created_this_month',
        ]), [$monthStart])->get()->keyBy('supplier_id');

        $overdue = $pos()->where('status', '<>', PurchaseOrder::CANCELLED)->whereNotNull('due_on')->where('due_on', '<', $today)
            ->whereRaw('received_value_amount - paid_amount > 0')->groupBy('supplier_id')
            ->selectRaw('supplier_id, sum(received_value_amount - paid_amount) as amount, min(due_on) as since')->get()->keyBy('supplier_id');

        $paid = DB::table('supplier_payments')->where('tenant_id', $store->tenant_id)->where('store_id', $store->id)->whereIn('supplier_id', $ids)
            ->groupBy('supplier_id')->selectRaw('supplier_id, sum(amount) as paid')->pluck('paid', 'supplier_id');

        $products = DB::table('purchase_order_items as i')->join('purchase_orders as po', 'po.id', '=', 'i.purchase_order_id')
            ->join('product_variants as v', 'v.id', '=', 'i.variant_id')
            ->where('i.tenant_id', $store->tenant_id)->where('i.store_id', $store->id)->whereIn('po.supplier_id', $ids)
            ->groupBy('po.supplier_id')->selectRaw('po.supplier_id, count(distinct v.product_id) as n')->pluck('n', 'supplier_id');

        $receiptsThisMonth = DB::table('purchase_receipts as r')->join('purchase_orders as po', 'po.id', '=', 'r.purchase_order_id')
            ->where('r.tenant_id', $store->tenant_id)->where('r.store_id', $store->id)->whereIn('po.supplier_id', $ids)
            ->where('r.received_at', '>=', $monthStart)->distinct()->pluck('po.supplier_id')->flip();

        $out = [];
        foreach ($ids as $id) {
            $o = $orders->get($id);
            $owed = (int) ($o->received ?? 0) - (int) ($paid[$id] ?? 0);
            $late = $overdue->get($id);
            $overdueAmount = $late === null ? 0 : min((int) $late->amount, max($owed, 0));
            $out[$id] = [
                'products_count' => (int) ($products[$id] ?? 0),
                'open_pos_count' => (int) ($o->open_count ?? 0),
                'past_orders_count' => (int) ($o->past_count ?? 0),
                'owed_amount' => $owed,
                'overdue_amount' => $overdueAmount,
                'overdue_since' => $overdueAmount > 0 ? substr((string) $late->since, 0, 10) : null,
                'last_order_on' => PurchaseHistory::localDate($store, $o->last_order_at ?? null),
                'active_this_month' => (int) ($o->created_this_month ?? 0) > 0 || $receiptsThisMonth->has($id),
            ];
        }

        return $out;
    }
}
