<?php

declare(strict_types=1);

namespace App\Domain\Reports;

use App\Domain\Orders\Models\Order;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/** Shared helpers: integer-based ratios (4 decimals), floored per-unit amounts, the common order exclusions. */
final class ReportMath
{
    /** 0–1 share/rate with 4 decimals; null when the denominator is 0. */
    public static function ratio(int|float $part, int|float $whole): ?float
    {
        return $whole == 0 ? null : round($part / $whole, 4);
    }

    /** Like ratio() but 0 instead of null (shares inside lists whose total is never 0). */
    public static function share(int|float $part, int|float $whole): float
    {
        return self::ratio($part, $whole) ?? 0.0;
    }

    public static function oneDecimal(int|float $value, int|float $by): ?float
    {
        return $by == 0 ? null : round($value / $by, 1);
    }

    /** floor(amount / count) for paisa amounts (floors toward −∞ for losses). */
    public static function perUnit(int $amount, int $count): ?int
    {
        return $count === 0 ? null : (int) floor($amount / $count);
    }

    /**
     * Orders of the store, minus §6.4's common exclusions: still `pending_payment`, and abandoned (cancelled straight
     * from `pending_payment`, by the order_events status change).
     */
    public static function orders(string $tenantId, string $storeId): Builder
    {
        return DB::table('orders')
            ->where('orders.tenant_id', $tenantId)
            ->where('orders.store_id', $storeId)
            ->where('orders.status', '<>', Order::PENDING_PAYMENT)
            ->whereNotExists(fn (Builder $q) => $q->select(DB::raw(1))->from('order_events')
                ->whereColumn('order_events.order_id', 'orders.id')
                ->where('order_events.tenant_id', $tenantId)
                ->where('order_events.store_id', $storeId)
                ->where('order_events.type', 'status_changed')
                ->where('order_events.from_status', Order::PENDING_PAYMENT)
                ->where('order_events.to_status', Order::CANCELLED));
    }
}
