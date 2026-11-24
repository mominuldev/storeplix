<?php

declare(strict_types=1);

namespace App\Domain\Customers;

use App\Domain\Customers\Models\Customer;

/**
 * Customer-facing return risk (PHASE-8-5 P85-25, Q147) — the single place; the 8.8 fake-order guard may replace it.
 *   risky   = returned ≥ 2 and returned ÷ (delivered + returned) ≥ 0.5
 *   careful = returned ≥ 1 and the ratio ≥ 0.25
 *   good    = everything else
 * The SQL fragments mirror classify() on `customers` columns (integer arithmetic, no division).
 */
final class CustomerRisk
{
    public const GOOD = 'good';

    public const CAREFUL = 'careful';

    public const RISKY = 'risky';

    public static function classify(int $delivered, int $returned): string
    {
        $total = $delivered + $returned;
        if ($returned >= 2 && $returned * 2 >= $total) {
            return self::RISKY;
        }
        if ($returned >= 1 && $returned * 4 >= $total) {
            return self::CAREFUL;
        }

        return self::GOOD;
    }

    public static function of(Customer $customer): string
    {
        return self::classify((int) $customer->delivered_orders_count, (int) $customer->returned_orders_count);
    }

    /** SQL condition: the customer is `risky` (column prefix optional, e.g. "customers."). */
    public static function riskySql(string $prefix = ''): string
    {
        $r = $prefix.'returned_orders_count';
        $d = $prefix.'delivered_orders_count';

        return "({$r} >= 2 AND {$r} * 2 >= ({$d} + {$r}))";
    }

    /** SQL condition: the customer is `careful` (and not risky). */
    public static function carefulSql(string $prefix = ''): string
    {
        $r = $prefix.'returned_orders_count';
        $d = $prefix.'delivered_orders_count';

        return "({$r} >= 1 AND {$r} * 4 >= ({$d} + {$r}) AND NOT ".self::riskySql($prefix).')';
    }
}
