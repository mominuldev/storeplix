<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-7 P87-12: the store's `expenses_rev` token in TenantCache. Every expense write puts a fresh ULID there after
 * its transaction commits (a rolled-back write leaves the token as it was); the profit report cache key includes it, so
 * the next Profit & loss response reflects the write. A ULID, not a counter: a counter could repeat after eviction.
 */
final class ExpenseRevision
{
    public function __construct(
        private readonly TenantCache $cache,
        private readonly TenantContext $context,
    ) {}

    public static function key(string $storeId): string
    {
        return "expenses_rev:{$storeId}";
    }

    /** Current token, or '0' when none was ever written (or it was evicted: a fresh key either way). */
    public function token(string $storeId): string
    {
        return (string) ($this->cache->get(self::key($storeId)) ?? '0');
    }

    /** Schedules a new token for after the current transaction commits (at once when none is open). */
    public function bump(string $tenantId, string $storeId): void
    {
        DB::afterCommit(fn () => $this->context->run($tenantId, fn () => $this->cache->forever(self::key($storeId), strtolower((string) Str::ulid()))));
    }
}
