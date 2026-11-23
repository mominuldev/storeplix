<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;

class BillingExtend extends BillingOpsCommand
{
    protected $signature = 'billing:extend {tenant} {--days=} {--reason=} {--force}';

    protected $description = 'Move current_period_end (and trial_ends_at while trialing, grace_ends_at while past_due) forward';

    public function handle(AuditLogger $audit): int
    {
        $days = (int) $this->option('days');
        if (! $this->guard() || $days < 1 || $days > 366) {
            $days < 1 || $days > 366 ? $this->error('--days must be 1–366.') : null;

            return self::FAILURE;
        }
        $tenant = $this->tenantOf((string) $this->argument('tenant'));
        if ($tenant === null) {
            $this->error('Tenant not found.');

            return self::FAILURE;
        }

        return $this->inTenant($tenant->id, fn () => BillingLock::run($tenant->id, fn () => DB::transaction(function () use ($tenant, $days, $audit) {
            $sub = Subscription::query()->whereIn('status', Subscription::CURRENT_STATUSES)->lockForUpdate()->first();
            if ($sub === null) {
                $this->error('No current subscription.');

                return self::FAILURE;
            }
            $set = [];
            foreach (['current_period_end', 'trial_ends_at', 'grace_ends_at'] as $column) {
                if ($sub->{$column} !== null && ($column !== 'trial_ends_at' || $sub->status === Subscription::TRIALING)
                    && ($column !== 'grace_ends_at' || $sub->status === Subscription::PAST_DUE)) {
                    $set[$column] = $sub->{$column}->copy()->addDays($days);
                }
            }
            DB::table('subscriptions')->where('id', $sub->id)->where('tenant_id', $sub->tenant_id)->update($set + ['updated_at' => now()]);
            FeatureGate::forget($tenant->id);
            $audit->log('billing.period_extended', $sub, ['days' => $days, 'reason' => (string) $this->option('reason')], system: true);
            $this->info("Extended by {$days} day(s).");

            return self::SUCCESS;
        })));
    }
}
