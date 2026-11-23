<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Domains\Ops\SuspendDomain as SuspendDomainAction;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Console\Command;

/** P6-18 ops: any custom state → suspended. Thin caller of the shared Action (PHASE-8-1 P8-7). */
class SuspendDomain extends Command
{
    protected $signature = 'domains:suspend {hostname} {--reason= : Why (kept in the audit log)}';

    protected $description = 'Suspend a custom domain (abuse / phishing)';

    public function handle(SuspendDomainAction $action): int
    {
        $host = strtolower(rtrim(trim((string) $this->argument('hostname')), '.'));
        $reason = mb_substr(trim((string) $this->option('reason')) ?: 'ops', 0, 200);
        // cross-tenant: ops lookup of a hostname's owner; the transition runs inside the tenant.
        $owner = StoreDomain::withoutTenancy()->where('hostname', $host)->first(['id', 'tenant_id', 'type']);
        if ($owner === null || $owner->type !== StoreDomain::TYPE_CUSTOM) {
            $this->error('No custom domain with that hostname.');

            return self::FAILURE;
        }

        $done = $action->handle((string) $owner->tenant_id, (string) $owner->id, OpsActor::system($reason)) !== null;

        $this->info($done ? "Suspended {$host}." : "{$host} was already suspended.");

        return self::SUCCESS;
    }
}
