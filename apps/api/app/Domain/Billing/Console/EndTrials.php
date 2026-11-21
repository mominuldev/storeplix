<?php

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Console\Command;

class EndTrials extends Command
{
    protected $signature = 'subscriptions:end-trials';

    protected $description = 'Move expired trials to the Free plan (nothing is locked).';

    public function handle(TenantContext $context, AuditLogger $audit): int
    {
        $free = Plan::query()->where('code', Plan::FREE)->firstOrFail();
        $count = 0;

        // Platform job across tenants: explicit opt-out, then act inside each tenant's context.
        Subscription::withoutTenancy()
            ->where('status', Subscription::TRIALING)
            ->where('trial_ends_at', '<', now())
            ->orderBy('id')
            ->each(function (Subscription $row) use ($context, $audit, $free, &$count) {
                $context->run($row->tenant_id, function () use ($row, $audit, $free) {
                    $from = $row->plan?->code;
                    $row->forceFill([
                        'status' => Subscription::ACTIVE,
                        'plan_id' => $free->id,
                        'current_period_start' => now(),
                        'current_period_end' => now()->addMonth(),
                    ])->save();

                    $audit->log('subscription.trial_ended', $row, ['plan' => ['from' => $from, 'to' => $free->code]], actor: null, system: true);
                });
                $count++;
            });

        $this->info("Ended {$count} trial(s).");

        return self::SUCCESS;
    }
}
