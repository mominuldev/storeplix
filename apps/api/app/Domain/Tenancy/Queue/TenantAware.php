<?php

namespace App\Domain\Tenancy\Queue;

/**
 * Use on any queued job that touches tenant-owned data.
 *
 * The tenant is captured automatically at dispatch time (see TenancyServiceProvider:
 * the current tenant id is written into the queue payload as "tenant_id") and restored
 * by the RestoreTenantContext job middleware before handle() runs. A job can only act
 * on the tenant it was dispatched for; a job with no tenant fails instead of running
 * unscoped.
 *
 * Call ->forTenant($id) to pin a tenant explicitly (e.g. from platform/system code).
 */
trait TenantAware
{
    public ?string $tenantId = null;

    public function forTenant(string $tenantId): static
    {
        $this->tenantId = $tenantId;

        return $this;
    }

    /**
     * @return array<int, object>
     */
    public function middleware(): array
    {
        return [new RestoreTenantContext];
    }
}
