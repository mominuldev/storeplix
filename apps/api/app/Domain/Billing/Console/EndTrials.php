<?php

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Jobs\ProcessSubscriptionJob;
use App\Domain\Billing\Models\Subscription;
use Illuminate\Console\Command;

/** Kept as an ops alias (PHASE-7 §12): ends due trials through the billing:run job; removed from the schedule. */
class EndTrials extends Command
{
    protected $signature = 'subscriptions:end-trials';

    protected $description = 'Move expired trials to the Free plan (nothing is locked). Alias of the billing:run trial step.';

    public function handle(): int
    {
        // cross-tenant: billing schedule (B24) — discovery only.
        $tenants = Subscription::withoutTenancy()->where('status', Subscription::TRIALING)->where('trial_ends_at', '<', now())
            ->orderBy('id')->pluck('tenant_id')->unique();
        foreach ($tenants as $tenantId) {
            dispatch_sync(new ProcessSubscriptionJob((string) $tenantId));
        }
        $this->info("Ended {$tenants->count()} trial(s).");

        return self::SUCCESS;
    }
}
