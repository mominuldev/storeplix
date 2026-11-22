<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\Jobs\CheckDomainJob;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Console\Command;

/**
 * §2.2 `domains:check` (scheduler, every minute, withoutOverlapping): discovery of due custom domains on the platform
 * connection (B19), then one tenant-aware CheckDomainJob per row.
 */
class CheckDomains extends Command
{
    protected $signature = 'domains:check {--limit= : Max rows (default domains.check_batch)}';

    protected $description = 'Dispatch a check for every custom domain whose next_check_at is due';

    public function handle(): int
    {
        $limit = max(1, (int) ($this->option('limit') ?: config('domains.check_batch', 500)));
        // cross-tenant: due domain checks (ids + tenant only; each check runs inside its tenant).
        $rows = StoreDomain::withoutTenancy()
            ->where('type', StoreDomain::TYPE_CUSTOM)
            ->whereNotNull('next_check_at')
            ->where('next_check_at', '<=', now())
            ->orderBy('next_check_at')
            ->limit($limit)
            ->get(['id', 'tenant_id']);

        foreach ($rows as $row) {
            CheckDomainJob::dispatch((string) $row->id)->forTenant((string) $row->tenant_id);
        }
        $this->info("Dispatched {$rows->count()} domain check(s).");

        return self::SUCCESS;
    }
}
