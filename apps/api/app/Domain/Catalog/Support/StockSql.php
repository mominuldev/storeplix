<?php

namespace App\Domain\Catalog\Support;

use App\Domain\Inventory\Models\Inventory;
use Illuminate\Support\Facades\DB;

/**
 * SQL fragments for the stock status rules of §3.3 (inventories joined as "inventories" through InventorySql; a
 * LEFT-joined missing row reads as 0, PHASE-8-8C P88C-3).
 */
final class StockSql
{
    public static function available(string $table = 'inventories'): string
    {
        return "(COALESCE({$table}.on_hand, 0) - COALESCE({$table}.committed, 0))";
    }

    public static function threshold(string $table = 'inventories'): string
    {
        return "COALESCE({$table}.low_stock_threshold, ".Inventory::DEFAULT_LOW_STOCK_THRESHOLD.')';
    }

    /** WHERE fragment for one StockStatus filter value (in|low|out|untracked), variants joined as product_variants. */
    public static function condition(string $status): string
    {
        $a = self::available();
        $t = self::threshold();

        return match ($status) {
            'untracked' => 'product_variants.track_inventory = '.self::false(),
            'out' => 'product_variants.track_inventory = '.self::true()." AND {$a} <= 0",
            'low' => 'product_variants.track_inventory = '.self::true()." AND {$a} > 0 AND {$a} <= {$t}",
            'in' => 'product_variants.track_inventory = '.self::true()." AND {$a} > {$t}",
        };
    }

    public static function true(): string
    {
        return DB::getDriverName() === 'pgsql' ? 'true' : '1';
    }

    public static function false(): string
    {
        return DB::getDriverName() === 'pgsql' ? 'false' : '0';
    }

    /** Case-insensitive LIKE operator. */
    public static function like(): string
    {
        return DB::getDriverName() === 'pgsql' ? 'ilike' : 'like';
    }

    /** "%term%" with LIKE wildcards escaped. */
    public static function contains(string $term): string
    {
        return '%'.addcslashes($term, '%_\\').'%';
    }
}
