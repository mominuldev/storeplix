<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\Ops\ReinstateDomain as ReinstateDomainAction;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Console\Command;

/** P6-18 ops: reinstate a suspended custom domain. Thin caller of the shared Action (PHASE-8-1 P8-7). */
class ReinstateDomain extends Command
{
    protected $signature = 'domains:reinstate {hostname}';

    protected $description = 'Reinstate a suspended custom domain';

    public function handle(ReinstateDomainAction $action): int
    {
        $host = strtolower(rtrim(trim((string) $this->argument('hostname')), '.'));
        // cross-tenant: ops lookup of a hostname's owner; the transition runs inside the tenant.
        $owner = StoreDomain::withoutTenancy()->where('hostname', $host)->first(['id', 'tenant_id', 'status']);
        if ($owner === null || $owner->status !== StoreDomain::STATUS_SUSPENDED) {
            $this->error('No suspended domain with that hostname.');

            return self::FAILURE;
        }

        $row = $action->handle((string) $owner->tenant_id, (string) $owner->id);

        $this->info("{$host} is now ".($row?->status ?? $owner->status).'.');

        return self::SUCCESS;
    }
}
