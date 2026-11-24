<?php

declare(strict_types=1);

namespace App\Domain\Inventory;

use App\Domain\Inventory\Models\Inventory;
use Illuminate\Database\Eloquent\Builder as EloquentBuilder;
use Illuminate\Database\Query\Builder;
use Illuminate\Database\Query\JoinClause;
use Illuminate\Support\Facades\DB;

/**
 * The ONLY places that join `inventories` into a variant query (PHASE-8-8C P88C-6, S185; InventoryReaderParityTest
 * fails on any other 1:1 join). Each join is aliased "inventories" so StockSql fragments keep working:
 *
 *  - joinTotals(): one row per variant with Σ on_hand / Σ committed over NON-ARCHIVED locations, the default row's
 *    threshold, the latest updated_at and `low_rows` (rows at or below their own threshold, P88C-6 dashboard "low").
 *    Rows at archived locations still group (sums 0), so a variant never drops out of a list.
 *  - joinOnline(): the online (default) location's row; missing row = NULL (LEFT JOIN).
 *  - joinLocation(): one location's row; missing row = NULL (LEFT JOIN, so a variant with no row there reads 0).
 */
final class InventorySql
{
    /** Per-variant totals of one store. */
    public static function totals(string $storeId): Builder
    {
        $active = 'locations.archived_at IS NULL';
        $threshold = 'COALESCE(inventories.low_stock_threshold, '.Inventory::DEFAULT_LOW_STOCK_THRESHOLD.')';

        return DB::table('inventories')
            ->join('locations', 'locations.id', '=', 'inventories.location_id')
            ->where('inventories.store_id', $storeId)
            ->groupBy('inventories.variant_id')
            ->selectRaw(implode(', ', [
                'inventories.variant_id as variant_id',
                "sum(CASE WHEN {$active} THEN inventories.on_hand ELSE 0 END) as on_hand",
                "sum(CASE WHEN {$active} THEN inventories.committed ELSE 0 END) as committed",
                'max(CASE WHEN locations.is_default = true THEN inventories.low_stock_threshold END) as low_stock_threshold',
                'max(inventories.updated_at) as updated_at',
                "sum(CASE WHEN {$active} AND inventories.on_hand - inventories.committed > 0 AND inventories.on_hand - inventories.committed <= {$threshold} THEN 1 ELSE 0 END) as low_rows",
                "sum(CASE WHEN {$active} THEN 1 ELSE 0 END) as active_rows",
            ]));
    }

    /**
     * @template T of Builder|EloquentBuilder
     *
     * @param  T  $query  a query over product_variants
     * @return T
     */
    public static function joinTotals(Builder|EloquentBuilder $query, string $storeId): Builder|EloquentBuilder
    {
        return $query->joinSub(self::totals($storeId), 'inventories', 'inventories.variant_id', '=', 'product_variants.id');
    }

    /**
     * @template T of Builder|EloquentBuilder
     *
     * @param  T  $query  a query over product_variants
     * @return T
     */
    public static function joinOnline(Builder|EloquentBuilder $query): Builder|EloquentBuilder
    {
        return $query->leftJoin('inventories', function (JoinClause $join) {
            $join->on('inventories.variant_id', '=', 'product_variants.id')->whereRaw(Inventory::ONLINE_SQL);
        });
    }

    /**
     * @template T of Builder|EloquentBuilder
     *
     * @param  T  $query  a query over product_variants
     * @return T
     */
    public static function joinLocation(Builder|EloquentBuilder $query, string $locationId): Builder|EloquentBuilder
    {
        return $query->leftJoin('inventories', function (JoinClause $join) use ($locationId) {
            $join->on('inventories.variant_id', '=', 'product_variants.id')->where('inventories.location_id', '=', $locationId);
        });
    }
}
