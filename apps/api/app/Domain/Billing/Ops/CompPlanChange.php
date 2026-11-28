<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\DowngradeEnforcer;
use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\SubscriptionStateMachine;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * Comp plan change with no invoice, inside the tenant (P8-7). Audit `subscription.plan_changed`.
 *
 * - Ops command (PHASE-7 §4.4 `billing:change-plan`, `$staffChange = false`): plan + interval from now for one period
 *   (Phase 7 behaviour, unchanged).
 * - Admin "Change plan → Now" (PHASE-8-1 P8-13, `$staffChange = true`): 409 `plan_unchanged` for the same plan and
 *   interval; the tenant's open invoice is voided `superseded`; the current period dates are kept, except from Free,
 *   a trial or a lapsed period, where a new period of one interval starts now.
 */
final class CompPlanChange
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly DowngradeEnforcer $enforcer,
        private readonly InvoiceService $invoices,
    ) {}

    /** @throws ApiException 422 plan_unavailable, 409 plan_unchanged, 409 invalid_state_transition (no current subscription) */
    public function handle(string $tenantId, string $planCode, string $interval, OpsActor $actor, bool $staffChange = false): Subscription
    {
        $plan = Plan::query()->where('code', $planCode)->first();
        if ($plan === null || ! in_array($interval, Plan::INTERVALS, true) || $plan->priceFor($interval) === null) {
            throw new ApiException(422, 'plan_unavailable', 'This plan is not available with that billing interval.', ['plan_code' => ['This plan is not available with that billing interval.']]);
        }

        return $this->context->run($tenantId, fn () => BillingLock::run($tenantId, fn () => DB::transaction(function () use ($plan, $interval, $actor, $staffChange) {
            $sub = Subscription::query()->with('plan')->whereIn('status', Subscription::CURRENT_STATUSES)->lockForUpdate()->first();
            if ($sub === null) {
                throw new ApiException(409, 'invalid_state_transition', 'No current subscription.');
            }
            $from = $sub->plan->code;
            $now = now();
            [$start, $end] = [$now->copy(), BillingQuoteService::addInterval($now, $interval)];
            if ($staffChange) {
                if ($sub->plan_id === $plan->id && $sub->billing_interval === $interval && $sub->status !== Subscription::TRIALING) {
                    throw new ApiException(409, 'plan_unchanged', 'The shop is already on this plan.');
                }
                $keep = ! $sub->plan->isFree() && $sub->status !== Subscription::TRIALING
                    && $sub->current_period_start !== null && $sub->current_period_end?->isFuture();
                if ($keep) {
                    [$start, $end] = [$sub->current_period_start, $sub->current_period_end];
                }
                $open = BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
                if ($open !== null) {
                    $this->invoices->void($open, BillingInvoice::VOID_SUPERSEDED, false, $actor->staff);
                }
            }
            SubscriptionStateMachine::move($sub, $sub->status, Subscription::ACTIVE, [
                'plan_id' => $plan->id, 'billing_interval' => $interval, 'current_period_start' => $start,
                'current_period_end' => $end, 'scheduled_plan_id' => null,
                'scheduled_interval' => null, 'past_due_at' => null, 'grace_ends_at' => null, 'plan_changed_at' => $now,
            ]);
            $actor->audit('subscription.plan_changed', $sub, ['from' => $from, 'to' => $plan->code, 'interval' => $interval,
                'kind' => $staffChange ? 'comp' : 'ops', 'reason' => $actor->reason]);
            $this->enforcer->planChanged($this->context->tenant(), $sub->refresh()->load('plan'));

            return $sub;
        })));
    }
}
