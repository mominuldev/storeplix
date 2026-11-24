<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Read helpers shared by the purchasing screens: "last bought at" unit costs (§5.1), incoming units of open POs
 * (§7, inventory INCOMING) and the store-local calendar (dates are store timezone, §0 conventions).
 */
final class PurchaseHistory
{
    public static function tz(Store $store): string
    {
        return $store->timezone ?: 'Asia/Dhaka';
    }

    public static function today(Store $store): string
    {
        return CarbonImmutable::now(self::tz($store))->format('Y-m-d');
    }

    /** Start of the current calendar month (store tz) as a UTC instant. */
    public static function monthStart(Store $store): CarbonImmutable
    {
        return CarbonImmutable::now(self::tz($store))->startOfMonth()->utc();
    }

    /** A timestamp as the store-local `Y-m-d`. */
    public static function localDate(Store $store, mixed $at): ?string
    {
        if ($at === null) {
            return null;
        }

        return CarbonImmutable::parse($at, 'UTC')->setTimezone(self::tz($store))->format('Y-m-d');
    }

    /**
     * The last unit cost each variant was bought at (POs that were ordered, never drafts or cancelled), newest PO first;
     * optionally only from one supplier and never from $exceptPo.
     *
     * @param  list<string>  $variantIds
     * @return array<string, array{unit_cost: int, supplier_id: string}>
     */
    public static function lastUnitCosts(Store $store, array $variantIds, ?string $supplierId = null, ?string $exceptPo = null): array
    {
        if ($variantIds === []) {
            return [];
        }
        $rows = DB::table('purchase_order_items as i')
            ->join('purchase_orders as po', 'po.id', '=', 'i.purchase_order_id')
            ->where('i.tenant_id', $store->tenant_id)->where('i.store_id', $store->id)
            ->whereIn('i.variant_id', $variantIds)
            ->whereNotIn('po.status', [PurchaseOrder::DRAFT, PurchaseOrder::CANCELLED])
            ->when($supplierId !== null, fn ($q) => $q->where('po.supplier_id', $supplierId))
            ->when($exceptPo !== null, fn ($q) => $q->where('po.id', '!=', $exceptPo))
            ->orderByDesc('po.created_at')->orderByDesc('po.id')
            ->get(['i.variant_id', 'i.unit_cost_amount', 'po.supplier_id']);

        $out = [];
        foreach ($rows as $row) {
            $out[$row->variant_id] ??= ['unit_cost' => (int) $row->unit_cost_amount, 'supplier_id' => (string) $row->supplier_id];
        }

        return $out;
    }

    /**
     * Units still expected per variant on open POs (`ordered` / `partially_received`; Σ ordered − received − damaged).
     *
     * @param  list<string>|null  $variantIds  null = every variant of the store
     * @return array<string, int>
     */
    public static function incoming(Store $store, ?array $variantIds = null, ?string $locationId = null): array
    {
        if ($variantIds === []) {
            return [];
        }

        return DB::table('purchase_order_items as i')
            ->join('purchase_orders as po', 'po.id', '=', 'i.purchase_order_id')
            ->where('i.tenant_id', $store->tenant_id)->where('i.store_id', $store->id)
            ->whereIn('po.status', PurchaseOrder::OPEN)
            ->when($variantIds !== null, fn ($q) => $q->whereIn('i.variant_id', $variantIds))
            ->when($locationId !== null, fn ($q) => $q->where('po.location_id', $locationId)) // PHASE-8-8C §5.4
            ->groupBy('i.variant_id')
            ->selectRaw('i.variant_id, sum(CASE WHEN i.quantity_ordered - i.quantity_received - i.quantity_damaged > 0 THEN i.quantity_ordered - i.quantity_received - i.quantity_damaged ELSE 0 END) as incoming')
            ->pluck('incoming', 'variant_id')->map(fn ($v) => (int) $v)->all();
    }
}
