<?php

declare(strict_types=1);

namespace App\Domain\Billing\Support;

use Illuminate\Support\Facades\Cache;

/**
 * P7-9 / §3.1: every billing transition of a tenant runs under `billing:tenant:{tenant}` (30 s; waits up to 15 s).
 * Re-entrant within the process (a payment confirmation inside the subscription job never deadlocks on itself).
 */
final class BillingLock
{
    /** @var array<string, true> */
    private static array $held = [];

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function run(string $tenantId, callable $callback): mixed
    {
        if (isset(self::$held[$tenantId])) {
            return $callback();
        }

        return Cache::lock("billing:tenant:{$tenantId}", 30)->block(15, function () use ($tenantId, $callback) {
            self::$held[$tenantId] = true;
            try {
                return $callback();
            } finally {
                unset(self::$held[$tenantId]);
            }
        });
    }
}
