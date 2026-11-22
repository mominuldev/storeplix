<?php

namespace App\Domain\Stores\Revalidation;

/**
 * Mutes StorefrontRevalidationObserver for bulk work (P4-23): an import of 5 000 rows dispatches one
 * RevalidateStorefront at the end instead of one per saved model.
 */
final class StorefrontRevalidation
{
    private static int $muted = 0;

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function muted(callable $callback): mixed
    {
        self::$muted++;
        try {
            return $callback();
        } finally {
            self::$muted--;
        }
    }

    public static function isMuted(): bool
    {
        return self::$muted > 0;
    }
}
