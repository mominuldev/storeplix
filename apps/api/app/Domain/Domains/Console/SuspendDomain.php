<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\DomainFailureCode;
use App\Domain\Domains\DomainLock;
use App\Domain\Domains\DomainStateMachine;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/** P6-18 ops: any custom state → suspended (unroutable at once, primary falls back, provider hostname kept). */
class SuspendDomain extends Command
{
    protected $signature = 'domains:suspend {hostname} {--reason= : Why (kept in the audit log)}';

    protected $description = 'Suspend a custom domain (abuse / phishing)';

    public function handle(TenantContext $context, DomainStateMachine $machine, AuditLogger $audit): int
    {
        $host = strtolower(rtrim(trim((string) $this->argument('hostname')), '.'));
        $reason = mb_substr(trim((string) $this->option('reason')) ?: 'ops', 0, 200);
        // cross-tenant: ops lookup of a hostname's owner; the transition runs inside the tenant.
        $owner = StoreDomain::withoutTenancy()->where('hostname', $host)->first(['id', 'tenant_id', 'type']);
        if ($owner === null || $owner->type !== StoreDomain::TYPE_CUSTOM) {
            $this->error('No custom domain with that hostname.');

            return self::FAILURE;
        }

        $done = $context->run((string) $owner->tenant_id, fn () => DomainLock::run((string) $owner->id, function () use ($owner, $machine, $audit, $reason) {
            $row = StoreDomain::query()->findOrFail($owner->id);
            if ($row->status === StoreDomain::STATUS_SUSPENDED) {
                return false;
            }
            $moved = $machine->transition($row, StoreDomain::STATUS_SUSPENDED, [], DomainFailureCode::Suspended, reason: 'suspend');
            if ($moved !== null) {
                $audit->log('domain.suspended', $row, ['hostname' => $row->hostname, 'reason' => $reason], tenantId: $row->tenant_id, system: true);
            }

            return $moved !== null;
        }));

        $this->info($done ? "Suspended {$host}." : "{$host} was already suspended.");

        return self::SUCCESS;
    }
}
