<?php

declare(strict_types=1);

namespace App\Domain\Developer\Console;

use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Developer\Webhooks\WebhookEndpoints;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * `webhooks:auto-disable` (hourly, P84-11): endpoints with no 2xx for 72 h since their first failure are disabled
 * (`disabled_reason = failing`, audit `webhook_endpoint.auto_disabled`). Discovery cross-tenant, work per tenant.
 */
class AutoDisableWebhookEndpoints extends Command
{
    protected $signature = 'webhooks:auto-disable';

    protected $description = 'Disable webhook endpoints that have failed for 72 hours';

    public function handle(TenantContext $context): int
    {
        $cutoff = now()->subHours((int) config('webhooks_out.auto_disable_hours', 72));
        // cross-tenant: scheduler discovery (platform connection); each tenant's endpoints are disabled in its context.
        $tenants = WebhookEndpoint::withoutTenancy()->where('is_active', true)->whereNotNull('failing_since')
            ->where('failing_since', '<=', $cutoff)->distinct()->pluck('tenant_id')->all();
        $count = 0;
        foreach ($tenants as $tenantId) {
            $count += (int) $context->run((string) $tenantId, fn () => app(WebhookEndpoints::class)->autoDisable());
        }
        $this->info("webhooks:auto-disable: {$count} endpoint(s) disabled.");

        return self::SUCCESS;
    }
}
