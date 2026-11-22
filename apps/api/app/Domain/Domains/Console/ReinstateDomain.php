<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\DomainChecker;
use App\Domain\Domains\DomainLock;
use App\Domain\Domains\DomainStateMachine;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\ProviderException;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * P6-18 ops: runs a check now. DNS passes → `active` when the provider hostname is live, else `ssl_provisioning`;
 * fails (or no provider hostname) → `pending_verification` with a fresh 72 h window.
 */
class ReinstateDomain extends Command
{
    protected $signature = 'domains:reinstate {hostname}';

    protected $description = 'Reinstate a suspended custom domain';

    public function handle(TenantContext $context, DomainStateMachine $machine, DomainChecker $checker, CustomHostnameProvider $provider, AuditLogger $audit): int
    {
        $host = strtolower(rtrim(trim((string) $this->argument('hostname')), '.'));
        // cross-tenant: ops lookup of a hostname's owner; the transition runs inside the tenant.
        $owner = StoreDomain::withoutTenancy()->where('hostname', $host)->first(['id', 'tenant_id', 'status']);
        if ($owner === null || $owner->status !== StoreDomain::STATUS_SUSPENDED) {
            $this->error('No suspended domain with that hostname.');

            return self::FAILURE;
        }

        $status = $context->run((string) $owner->tenant_id, fn () => DomainLock::run((string) $owner->id, function () use ($owner, $machine, $checker, $provider, $audit) {
            $row = StoreDomain::query()->findOrFail($owner->id);
            $live = false;
            $exists = false;
            if ($row->provider_hostname_id !== null) {
                try {
                    $hostname = $provider->get($row->provider_hostname_id);
                    $exists = $hostname !== null;
                    $live = $hostname?->isLive() ?? false;
                } catch (ProviderException) {
                    $exists = true; // keep the hostname; SSL polling sorts it out
                }
            }
            $to = match (true) {
                ! $checker->dns($row)->passed() || ! $exists => StoreDomain::STATUS_PENDING_VERIFICATION,
                $live => StoreDomain::STATUS_ACTIVE,
                default => StoreDomain::STATUS_SSL_PROVISIONING,
            };
            $set = match ($to) {
                StoreDomain::STATUS_PENDING_VERIFICATION => ['verification_started_at' => now(), 'first_failed_at' => null],
                default => ['first_failed_at' => null, 'unproven_since' => null], // DNS (TXT) passed
            };
            $moved = $machine->transition($row, $to, $set, reason: 'reinstate');
            if ($moved !== null) {
                $audit->log('domain.reinstated', $row, ['hostname' => $row->hostname, 'reason' => $to], tenantId: $row->tenant_id, system: true);
            }

            return $moved?->status ?? $row->status;
        }));

        $this->info("{$host} is now {$status}.");

        return self::SUCCESS;
    }
}
