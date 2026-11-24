<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\Customers\Models\Customer;
use InvalidArgumentException;

/**
 * The one risk tier of the product (PHASE-8-8 P88-3/P88-4; replaces PHASE-8-5 P85-25 `CustomerRisk`). Input is a
 * phone's OWN-SHOP record: delivered and returned parcels at this store only.
 *
 *   total = 0                      → new
 *   total < min_parcels            → careful when returned ≥ 1, else good (no ratio verdict on thin history)
 *   rate < hold_below              → risky
 *   rate < advance_below           → careful
 *   else                           → good
 *
 * rate = delivered ÷ total as a whole percent rounded half down = ⌊(200·d + t − 1) ÷ 2t⌋. In integers,
 * `rate < H ⇔ 200·d ≤ (2H − 1)·t`, which is what the SQL form uses (no division, no floats), so the PHP and SQL forms
 * agree on every input (S163). Thresholds are the store's guard settings, or the defaults (60, 75, 3).
 */
final class RiskTier
{
    public const GOOD = 'good';

    public const CAREFUL = 'careful';

    public const RISKY = 'risky';

    public const NEW_NUMBER = 'new';

    public const ALL = [self::GOOD, self::CAREFUL, self::RISKY, self::NEW_NUMBER];

    /** @var array{hold_below: int, advance_below: int, min_parcels: int} */
    public const DEFAULTS = ['hold_below' => 60, 'advance_below' => 75, 'min_parcels' => 3];

    /** Whole percent delivered, rounded half down; null when there are no parcels. */
    public static function rate(int $delivered, int $total): ?int
    {
        if ($total <= 0) {
            return null;
        }

        return intdiv(200 * $delivered + $total - 1, 2 * $total);
    }

    /** @param array{hold_below?: int, advance_below?: int, min_parcels?: int}|null $thresholds */
    public static function classify(int $delivered, int $returned, ?array $thresholds = null): string
    {
        $t = self::thresholds($thresholds);
        $total = $delivered + $returned;
        if ($total <= 0) {
            return self::NEW_NUMBER;
        }
        if ($total < $t['min_parcels']) {
            return $returned >= 1 ? self::CAREFUL : self::GOOD;
        }
        if (200 * $delivered <= (2 * $t['hold_below'] - 1) * $total) {
            return self::RISKY;
        }
        if (200 * $delivered <= (2 * $t['advance_below'] - 1) * $total) {
            return self::CAREFUL;
        }

        return self::GOOD;
    }

    /** The customer's tier from its own-shop counters and its store's thresholds. */
    public static function forCustomer(Customer $customer): string
    {
        return self::classify(
            (int) $customer->delivered_orders_count,
            (int) $customer->returned_orders_count,
            app(GuardSettings::class)->thresholds($customer->store_id),
        );
    }

    /**
     * `CustomerRisk` payload (§6.5): `{tier, rate, delivered, total}` from the customer's own-shop counters. A missing
     * customer (an order without a customer row) is a `new` record.
     *
     * @return array{tier: string, rate: int|null, delivered: int, total: int}
     */
    public static function payload(?Customer $customer, ?string $storeId = null): array
    {
        $delivered = (int) ($customer?->delivered_orders_count ?? 0);
        $returned = (int) ($customer?->returned_orders_count ?? 0);
        $storeId ??= $customer?->store_id;

        return [
            'tier' => self::classify($delivered, $returned, $storeId !== null ? app(GuardSettings::class)->thresholds($storeId) : null),
            'rate' => self::rate($delivered, $delivered + $returned),
            'delivered' => $delivered,
            'total' => $delivered + $returned,
        ];
    }

    /**
     * SQL condition (no bindings: thresholds are integers) for "the customer row is in $tier", over the
     * `delivered_orders_count` / `returned_orders_count` counters (campaign audiences, list filters).
     *
     * @param  array{hold_below?: int, advance_below?: int, min_parcels?: int}|null  $thresholds
     */
    public static function sql(string $tier, ?array $thresholds = null, string $prefix = ''): string
    {
        $t = self::thresholds($thresholds);
        $d = $prefix.'delivered_orders_count';
        $r = $prefix.'returned_orders_count';
        $total = "({$d} + {$r})";
        $min = $t['min_parcels'];
        $hold = 2 * $t['hold_below'] - 1;
        $advance = 2 * $t['advance_below'] - 1;
        $thick = "{$total} >= {$min}";
        $risky = "({$thick} AND 200 * {$d} <= {$hold} * {$total})";
        $carefulThick = "({$thick} AND 200 * {$d} > {$hold} * {$total} AND 200 * {$d} <= {$advance} * {$total})";

        return match ($tier) {
            self::NEW_NUMBER => "({$total} = 0)",
            self::RISKY => $risky,
            self::CAREFUL => "(({$total} > 0 AND {$total} < {$min} AND {$r} >= 1) OR {$carefulThick})",
            self::GOOD => "(({$total} > 0 AND {$total} < {$min} AND {$r} = 0) OR ({$thick} AND 200 * {$d} > {$advance} * {$total}))",
            default => throw new InvalidArgumentException("Unknown risk tier {$tier}."),
        };
    }

    /** SQL condition: the row is in any of $tiers. @param list<string> $tiers @param array<string, int>|null $thresholds */
    public static function sqlAny(array $tiers, ?array $thresholds = null, string $prefix = ''): string
    {
        $parts = array_map(fn (string $tier) => self::sql($tier, $thresholds, $prefix), array_values(array_unique($tiers)));

        return $parts === [] ? '(1 = 0)' : '('.implode(' OR ', $parts).')';
    }

    /**
     * @param  array{hold_below?: int, advance_below?: int, min_parcels?: int}|null  $thresholds
     * @return array{hold_below: int, advance_below: int, min_parcels: int}
     */
    public static function thresholds(?array $thresholds): array
    {
        $t = ($thresholds ?? []) + self::DEFAULTS;

        return ['hold_below' => (int) $t['hold_below'], 'advance_below' => (int) $t['advance_below'], 'min_parcels' => max(1, (int) $t['min_parcels'])];
    }
}
