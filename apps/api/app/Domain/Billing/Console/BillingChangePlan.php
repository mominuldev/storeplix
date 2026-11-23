<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Ops\CompPlanChange;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Shared\Http\ApiException;

/** Thin caller of the shared Action (PHASE-8-1 P8-7). */
class BillingChangePlan extends BillingOpsCommand
{
    protected $signature = 'billing:change-plan {tenant} {plan} {--interval=month} {--reason=} {--force}';

    protected $description = 'Comp plan: put the tenant on a plan for one period from now, with no invoice';

    public function handle(CompPlanChange $action): int
    {
        if (! $this->guard()) {
            return self::FAILURE;
        }
        $tenant = $this->tenantOf((string) $this->argument('tenant'));
        $plan = (string) $this->argument('plan');
        $interval = (string) $this->option('interval');
        if ($tenant === null) {
            $this->error('Unknown tenant, plan or interval.');

            return self::FAILURE;
        }

        try {
            $action->handle($tenant->id, $plan, $interval, OpsActor::system((string) $this->option('reason')));
        } catch (ApiException $e) {
            $this->error($e->getStatusCode() === 422 ? 'Unknown tenant, plan or interval.' : $e->getMessage());

            return self::FAILURE;
        }
        $this->info("{$tenant->id} is on {$plan} ({$interval}).");

        return self::SUCCESS;
    }
}
