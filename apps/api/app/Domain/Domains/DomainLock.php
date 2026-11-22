<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use Illuminate\Support\Facades\Cache;

/**
 * P6-10: one worker at a time per domain (`Cache::lock("domain:{id}")`, 30 s). Re-entrant within the process, so a
 * check that transitions (and the transition's own work) never deadlocks on itself.
 */
final class DomainLock
{
    /** @var array<string, true> */
    private static array $held = [];

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function run(string $domainId, callable $callback, int $waitSeconds = 10): mixed
    {
        if (isset(self::$held[$domainId])) {
            return $callback();
        }

        return Cache::lock('domain:'.$domainId, 30)->block($waitSeconds, function () use ($domainId, $callback) {
            self::$held[$domainId] = true;
            try {
                return $callback();
            } finally {
                unset(self::$held[$domainId]);
            }
        });
    }
}
