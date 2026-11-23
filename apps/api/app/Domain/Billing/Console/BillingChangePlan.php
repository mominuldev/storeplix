<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\DowngradeEnforcer;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\SubscriptionStateMachine;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;

class BillingChangePlan extends BillingOpsCommand
{
    protected $signature = 'billing:change-plan {tenant} {plan} {--interval=month} {--reason=} {--force}';

    protected $description = 'Comp plan: put the tenant on a plan for one period from now, with no invoice';

    public function handle(AuditLogger $audit, DowngradeEnforcer $enforcer): int
    {
        if (! $this->guard()) {
            return self::FAILURE;
        }
        $tenant = $this->tenantOf((string) $this->argument('tenant'));
        $plan = Plan::query()->where('code', (string) $this->argument('plan'))->first();
        $interval = (string) $this->option('interval');
        if ($tenant === null || $plan === null || $plan->priceFor($interval) === null) {
            $this->error('Unknown tenant, plan or interval.');

            return self::FAILURE;
        }

        return $this->inTenant($tenant->id, fn () => BillingLock::run($tenant->id, fn () => DB::transaction(function () use ($tenant, $plan, $interval, $audit, $enforcer) {
            $sub = Subscription::query()->with('plan')->whereIn('status', Subscription::CURRENT_STATUSES)->lockForUpdate()->first();
            if ($sub === null) {
                $this->error('No current subscription.');

                return self::FAILURE;
            }
            $from = $sub->plan->code;
            SubscriptionStateMachine::move($sub, $sub->status, Subscription::ACTIVE, [
                'plan_id' => $plan->id, 'billing_interval' => $interval, 'current_period_start' => now(),
                'current_period_end' => BillingQuoteService::addInterval(now(), $interval), 'scheduled_plan_id' => null,
                'scheduled_interval' => null, 'past_due_at' => null, 'grace_ends_at' => null, 'plan_changed_at' => now(),
            ]);
            $audit->log('subscription.plan_changed', $sub, ['from' => $from, 'to' => $plan->code, 'interval' => $interval, 'kind' => 'ops',
                'reason' => (string) $this->option('reason')], system: true);
            $enforcer->planChanged($tenant, $sub->refresh()->load('plan'));
            $this->info("{$tenant->id} is on {$plan->code} ({$interval}).");

            return self::SUCCESS;
        })));
    }
}
