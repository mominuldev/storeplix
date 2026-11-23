<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

/**
 * §4.4 ops commands (B24; no super-admin UI until 8.1). Every write needs `--reason`, `--force` in production, runs in
 * the tenant's context and writes audit with `actor_type: system`.
 */
abstract class BillingOpsCommand extends Command
{
    protected function guard(bool $write = true): bool
    {
        if ($write && trim((string) $this->option('reason')) === '') {
            $this->error('--reason is required.');

            return false;
        }
        if ($write && app()->environment('production') && ! $this->option('force')) {
            $this->error('Refusing to run in production without --force.');

            return false;
        }

        return true;
    }

    protected function tenantOf(string $tenant): ?Tenant
    {
        return Tenant::query()->whereKey(strtolower($tenant))->first();
    }

    /** cross-tenant: ops lookup of an invoice by number or id (B24); returns [tenant id, invoice id]. */
    protected function locateInvoice(string $invoice): ?array
    {
        $row = BillingInvoice::withoutTenancy()->where('number', strtoupper($invoice))->orWhere('id', strtolower($invoice))->first(['id', 'tenant_id']);

        return $row === null ? null : [(string) $row->tenant_id, (string) $row->id];
    }

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    protected function inTenant(string $tenantId, callable $callback): mixed
    {
        return app(TenantContext::class)->run($tenantId, $callback);
    }
}
