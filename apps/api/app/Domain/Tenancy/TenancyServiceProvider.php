<?php

namespace App\Domain\Tenancy;

use Illuminate\Support\Facades\Queue;
use Illuminate\Support\ServiceProvider;

class TenancyServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Scoped: flushed between requests (Octane) and between queue jobs.
        $this->app->scoped(TenantContext::class);
    }

    public function boot(): void
    {
        // Capture the current tenant into every queued payload. TenantAware jobs restore it
        // through the RestoreTenantContext job middleware.
        Queue::createPayloadUsing(function (?string $connection, ?string $queue, array $payload): array {
            $tenantId = $this->app->make(TenantContext::class)->id();

            return $tenantId !== null ? ['tenant_id' => $tenantId] : [];
        });
    }
}
