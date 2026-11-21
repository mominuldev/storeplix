<?php

namespace App\Domain\Tenancy\Queue;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use App\Domain\Tenancy\TenantContext;
use Closure;

/**
 * Job middleware: restores the TenantContext the job was dispatched under.
 */
class RestoreTenantContext
{
    public function handle(object $job, Closure $next): mixed
    {
        $tenantId = $this->resolveTenantId($job);

        if ($tenantId === null) {
            throw new MissingTenantContextException(sprintf('Tenant-aware job [%s] has no tenant.', $job::class));
        }

        return app(TenantContext::class)->run($tenantId, fn () => $next($job));
    }

    private function resolveTenantId(object $job): ?string
    {
        if (property_exists($job, 'tenantId') && is_string($job->tenantId) && $job->tenantId !== '') {
            return $job->tenantId;
        }

        // Fallback: tenant captured into the raw queue payload at dispatch time.
        if (property_exists($job, 'job') && $job->job !== null && method_exists($job->job, 'payload')) {
            $payloadTenant = $job->job->payload()['tenant_id'] ?? null;

            return is_string($payloadTenant) && $payloadTenant !== '' ? $payloadTenant : null;
        }

        return null;
    }
}
