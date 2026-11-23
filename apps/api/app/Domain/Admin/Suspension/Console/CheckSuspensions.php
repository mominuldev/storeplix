<?php

declare(strict_types=1);

namespace App\Domain\Admin\Suspension\Console;

use App\Domain\Admin\Suspension\TenantSuspension;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * PHASE-8-1 §4.1 / §4.4 (hourly): repairs store/tenant suspension mismatches left by a crash between the two writes
 * of TenantSuspension. The tenant status is the source of truth; each fix logs a warning.
 */
class CheckSuspensions extends Command
{
    protected $signature = 'admin:check-suspensions';

    protected $description = 'Fix stores whose suspension does not match their tenant status';

    public function handle(TenantContext $context, TenantSuspension $suspension): int
    {
        // cross-tenant: platform discovery of mismatches; each fix runs inside its tenant.
        $rows = PlatformDb::connection()->table('stores as s')->join('tenants as t', 't.id', '=', 's.tenant_id')
            ->where(fn ($q) => $q->where(fn ($a) => $a->where('t.status', Tenant::STATUS_SUSPENDED)->where('s.status', '<>', Store::STATUS_SUSPENDED))
                ->orWhere(fn ($b) => $b->where('t.status', Tenant::STATUS_ACTIVE)->where('s.status', Store::STATUS_SUSPENDED)->whereNotNull('s.status_before_suspension')))
            ->get(['s.tenant_id', 't.status']);

        foreach ($rows as $row) {
            $tenantId = (string) $row->tenant_id;
            $suspend = $row->status === Tenant::STATUS_SUSPENDED;
            $context->run($tenantId, fn () => DB::transaction(fn () => $suspend ? $suspension->suspendStore() : $suspension->restoreStore()));
            $suspension->bust($tenantId);
            Log::warning('admin.suspension_mismatch_fixed', ['tenant_id' => $tenantId, 'store' => $suspend ? 'suspended' : 'restored']);
        }
        $this->info("Fixed {$rows->count()} mismatch(es).");

        return self::SUCCESS;
    }
}
