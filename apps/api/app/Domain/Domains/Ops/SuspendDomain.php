<?php

declare(strict_types=1);

namespace App\Domain\Domains\Ops;

use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Domains\DomainFailureCode;
use App\Domain\Domains\DomainLock;
use App\Domain\Domains\DomainStateMachine;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-6 P6-18 `domains:suspend` / PHASE-8-1 §4.2: any custom state → `suspended` (unroutable at once, the primary
 * falls back, the provider hostname is kept), inside the domain's tenant. Audit `domain.suspended` (hostname, reason).
 */
final class SuspendDomain
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly DomainStateMachine $machine,
    ) {}

    /** @return StoreDomain|null the suspended row; null when it was already suspended (nothing changed) */
    public function handle(string $tenantId, string $domainId, OpsActor $actor): ?StoreDomain
    {
        return $this->context->run($tenantId, fn () => DomainLock::run($domainId, function () use ($domainId, $actor) {
            $row = StoreDomain::query()->findOrFail($domainId);
            if ($row->status === StoreDomain::STATUS_SUSPENDED) {
                return null;
            }
            $moved = $this->machine->transition($row, StoreDomain::STATUS_SUSPENDED, [], DomainFailureCode::Suspended, reason: 'suspend');
            if ($moved !== null) {
                $actor->audit('domain.suspended', $row, ['hostname' => $row->hostname, 'reason' => $actor->reason], $row->tenant_id);
            }

            return $moved;
        }));
    }
}
