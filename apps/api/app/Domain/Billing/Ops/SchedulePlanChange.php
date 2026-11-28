<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\BillingQuoteService;
use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Billing\SubscriptionStateMachine;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-1 P8-13 "Change plan → At next renewal": writes `scheduled_plan_id` / `scheduled_interval` exactly as a
 * merchant downgrade does (PlanChangeService::change): applied by `billing:run` at the period end, any open invoice
 * is superseded, audit `subscription.change_scheduled`. No invoice, no charge.
 */
final class SchedulePlanChange
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly PlanChangeService $plans,
        private readonly InvoiceService $invoices,
    ) {}

    /** @throws ApiException 422 plan_unavailable, 409 plan_unchanged */
    public function handle(string $tenantId, string $planCode, string $interval, OpsActor $actor): Subscription
    {
        return $this->context->run($tenantId, fn () => BillingLock::run($tenantId, fn () => DB::transaction(function () use ($planCode, $interval, $actor) {
            $target = PlanChangeService::targetPlan($planCode);
            if (! in_array($interval, Plan::INTERVALS, true) || $target->priceFor($interval) === null) {
                throw new ApiException(422, 'plan_unavailable', 'This plan is not available with that billing interval.', ['plan_code' => ['This plan is not available with that billing interval.']]);
            }
            $subscription = $this->plans->current(lock: true);
            $scheduledInterval = $target->isFree() ? Plan::MONTH : $interval;
            if ($subscription->plan_id === $target->id && $subscription->billing_interval === $scheduledInterval
                && $subscription->status !== Subscription::TRIALING) {
                throw new ApiException(409, 'plan_unchanged', 'The shop is already on this plan.');
            }
            if ($subscription->scheduled_plan_id === $target->id && $subscription->scheduled_interval === $scheduledInterval) {
                return $subscription;
            }
            $kind = match (true) {
                $target->isFree() => BillingQuoteService::CANCEL,
                $target->sort > $subscription->plan->sort || ($target->id === $subscription->plan_id && $scheduledInterval === Plan::YEAR) => BillingQuoteService::UPGRADE,
                default => BillingQuoteService::DOWNGRADE,
            };
            SubscriptionStateMachine::move($subscription, $subscription->status, $subscription->status, [
                'scheduled_plan_id' => $target->id, 'scheduled_interval' => $scheduledInterval,
            ]);
            $open = BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
            if ($open !== null) {
                $this->invoices->void($open, BillingInvoice::VOID_SUPERSEDED, false, $actor->staff);
            }
            $actor->audit('subscription.change_scheduled', $subscription, [
                'from' => $subscription->plan->code, 'to' => $target->code, 'interval' => $scheduledInterval, 'kind' => $kind,
                'effective_at' => PlanChangeService::periodEndsAt($subscription)?->toIso8601ZuluString(), 'reason' => $actor->reason,
            ]);

            return $subscription->refresh()->load('plan');
        })));
    }
}
