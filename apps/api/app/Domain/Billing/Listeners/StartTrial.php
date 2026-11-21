<?php

namespace App\Domain\Billing\Listeners;

use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Tenancy\Events\TenantCreated;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;

/** Every new tenant starts a 14-day Starter trial (Phase 2 contract §1.6; PO to confirm Q10). */
class StartTrial
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(TenantCreated $event): void
    {
        $plan = Plan::query()->where('code', Plan::STARTER)->first();

        if ($plan === null) {
            return; // plans not seeded (should not happen: the billing migration seeds them)
        }

        $this->context->run($event->tenant, function () use ($plan) {
            $subscription = Subscription::query()->create([
                'plan_id' => $plan->id,
                'status' => Subscription::TRIALING,
                'trial_ends_at' => now()->addDays(Subscription::TRIAL_DAYS),
            ]);

            $this->audit->log('subscription.trial_started', $subscription, ['plan' => $plan->code], actor: null, system: true);
        });
    }
}
