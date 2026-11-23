<?php

declare(strict_types=1);

namespace App\Domain\Domains\Ops;

use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Domains\DomainChecker;
use App\Domain\Domains\DomainLock;
use App\Domain\Domains\DomainStateMachine;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\ProviderException;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-6 P6-18 `domains:reinstate` / PHASE-8-1 §4.2: runs a check now, inside the domain's tenant. DNS passes →
 * `active` when the provider hostname is live, else `ssl_provisioning`; fails (or no provider hostname) →
 * `pending_verification` with a fresh 72 h window. Audit `domain.reinstated`.
 */
final class ReinstateDomain
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly DomainStateMachine $machine,
        private readonly DomainChecker $checker,
        private readonly CustomHostnameProvider $provider,
    ) {}

    /**
     * @param  OpsActor|null  $actor  null = the ops command (Phase 6 meta: `reason` = the new status)
     * @return StoreDomain|null the row after the transition; null when it is not suspended
     */
    public function handle(string $tenantId, string $domainId, ?OpsActor $actor = null): ?StoreDomain
    {
        return $this->context->run($tenantId, fn () => DomainLock::run($domainId, function () use ($domainId, $actor) {
            $row = StoreDomain::query()->findOrFail($domainId);
            if ($row->status !== StoreDomain::STATUS_SUSPENDED) {
                return null;
            }
            $live = false;
            $exists = false;
            if ($row->provider_hostname_id !== null) {
                try {
                    $hostname = $this->provider->get($row->provider_hostname_id);
                    $exists = $hostname !== null;
                    $live = $hostname?->isLive() ?? false;
                } catch (ProviderException) {
                    $exists = true; // keep the hostname; SSL polling sorts it out
                }
            }
            $to = match (true) {
                ! $this->checker->dns($row)->passed() || ! $exists => StoreDomain::STATUS_PENDING_VERIFICATION,
                $live => StoreDomain::STATUS_ACTIVE,
                default => StoreDomain::STATUS_SSL_PROVISIONING,
            };
            $set = match ($to) {
                StoreDomain::STATUS_PENDING_VERIFICATION => ['verification_started_at' => now(), 'first_failed_at' => null],
                default => ['first_failed_at' => null, 'unproven_since' => null], // DNS (TXT) passed
            };
            $moved = $this->machine->transition($row, $to, $set, reason: 'reinstate');
            if ($moved !== null) {
                $meta = $actor === null ? ['hostname' => $row->hostname, 'reason' => $to] : ['hostname' => $row->hostname, 'reason' => $actor->reason, 'status' => $to];
                ($actor ?? OpsActor::system($to))->audit('domain.reinstated', $row, $meta, $row->tenant_id);
            }

            return $moved ?? StoreDomain::query()->findOrFail($domainId);
        }));
    }
}
