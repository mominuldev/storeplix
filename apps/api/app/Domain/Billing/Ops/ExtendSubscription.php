<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-7 §4.4 `billing:extend` / PHASE-8-1 P8-14: moves `current_period_end` forward (and `trial_ends_at` while
 * trialing, `grace_ends_at` while past_due) by `$days`, inside the tenant. Audit `billing.period_extended`.
 */
final class ExtendSubscription
{
    public function __construct(private readonly TenantContext $context) {}

    /** @throws ApiException 409 invalid_state_transition when the tenant has no current subscription */
    public function handle(string $tenantId, int $days, OpsActor $actor): Subscription
    {
        return $this->context->run($tenantId, fn () => BillingLock::run($tenantId, fn () => DB::transaction(function () use ($tenantId, $days, $actor) {
            $sub = Subscription::query()->whereIn('status', Subscription::CURRENT_STATUSES)->lockForUpdate()->first();
            if ($sub === null) {
                throw new ApiException(409, 'invalid_state_transition', 'No current subscription.');
            }
            $set = [];
            foreach (['current_period_end', 'trial_ends_at', 'grace_ends_at'] as $column) {
                if ($sub->{$column} !== null && ($column !== 'trial_ends_at' || $sub->status === Subscription::TRIALING)
                    && ($column !== 'grace_ends_at' || $sub->status === Subscription::PAST_DUE)) {
                    $set[$column] = $sub->{$column}->copy()->addDays($days);
                }
            }
            DB::table('subscriptions')->where('id', $sub->id)->where('tenant_id', $sub->tenant_id)->update($set + ['updated_at' => now()]);
            FeatureGate::forget($tenantId);
            $actor->audit('billing.period_extended', $sub, ['days' => $days, 'reason' => $actor->reason]);

            return $sub->refresh()->load('plan');
        })));
    }
}
