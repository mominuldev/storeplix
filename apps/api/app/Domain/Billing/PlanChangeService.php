<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Plan changes (PHASE-7 §3.1, §3.3, P7-5–P7-8, P7-14): quote → change-plan (an open `new`/`upgrade` invoice, or a
 * scheduled downgrade/cancel), and the subscription side of a paid invoice, of a scheduled change at period end and
 * of a non-payment expiry. Every write runs under BillingLock in one transaction with the subscription row locked.
 */
final class PlanChangeService
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly InvoiceService $invoices,
        private readonly DowngradeEnforcer $enforcer,
        private readonly AuditLogger $audit,
        private readonly BillingNotifier $notifier,
    ) {}

    public static function targetPlan(string $code): Plan
    {
        $plan = Plan::query()->where('code', $code)->first();
        if ($plan === null || ! $plan->is_active) {
            throw new ApiException(422, 'plan_unavailable', 'This plan is not available.', ['plan_code' => ['This plan is not available.']]);
        }

        return $plan;
    }

    /** The tenant's current subscription; a tenant without one is on Free (a row is created on first write). */
    public function current(bool $lock = false): Subscription
    {
        $query = Subscription::query()->with('plan')->whereIn('status', Subscription::CURRENT_STATUSES)->latest();
        $subscription = $lock ? $query->lockForUpdate()->first() : $query->first();
        if ($subscription !== null) {
            return $subscription;
        }
        $free = Plan::free();
        $subscription = Subscription::query()->create([
            'plan_id' => $free->id, 'status' => Subscription::ACTIVE, 'billing_interval' => Plan::MONTH,
            'current_period_start' => now(), 'current_period_end' => now()->addMonthNoOverflow(),
        ]);

        return $subscription->load('plan');
    }

    /** @return array<string, mixed> BillingQuote data (see BillingQuoteService::quote) */
    public function quote(string $planCode, string $interval): array
    {
        return BillingQuoteService::quote($this->context->tenant(), $this->current(), self::targetPlan($planCode), $interval);
    }

    /**
     * POST /billing/change-plan. Idempotent by key: the same key returns the invoice it created (409 mismatch when the
     * plan/interval differ); downgrades and cancellations are naturally idempotent.
     *
     * @return array{status: int, subscription: Subscription, invoice: BillingInvoice|null}
     */
    public function change(string $planCode, string $interval, string $idempotencyKey, Authenticatable $user): array
    {
        $tenant = $this->context->tenant();
        $target = self::targetPlan($planCode);

        return BillingLock::run($tenant->id, fn () => DB::transaction(function () use ($tenant, $target, $interval, $idempotencyKey, $user) {
            $existing = BillingInvoice::query()->where('idempotency_key', $idempotencyKey)->first();
            if ($existing !== null) {
                if ($existing->plan_id !== $target->id || $existing->interval !== $interval) {
                    throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
                }

                return ['status' => 201, 'subscription' => $this->current(), 'invoice' => $existing];
            }

            $subscription = $this->current(lock: true);
            $quote = BillingQuoteService::quote($tenant, $subscription, $target, $interval);
            $kind = $quote['kind'];

            if (in_array($kind, [BillingQuoteService::NEW, BillingQuoteService::UPGRADE], true)) {
                $invoice = $this->invoices->issue(
                    $subscription, $kind, $target, $interval, $quote['amount'], $quote['credit_amount'], $quote['lines'],
                    null, null, now()->addHours((int) config('billing.change_invoice_ttl_hours', 24)),
                    (string) $user->getAuthIdentifier(), $idempotencyKey,
                );

                return ['status' => 201, 'subscription' => $subscription->refresh()->load('plan'), 'invoice' => $invoice];
            }

            if ($subscription->status === Subscription::PAST_DUE) { // cancel in past_due: Free now
                $free = $this->expireToFree($tenant, $subscription, Subscription::ENDED_CANCELLED, $user);

                return ['status' => 200, 'subscription' => $free, 'invoice' => null];
            }

            // downgrade | cancel: scheduled for the period end (P7-6); any open invoice is superseded by the new plan.
            $scheduledInterval = $target->isFree() ? Plan::MONTH : $interval;
            if ($subscription->scheduled_plan_id === $target->id && $subscription->scheduled_interval === $scheduledInterval) {
                return ['status' => 200, 'subscription' => $subscription, 'invoice' => null];
            }
            SubscriptionStateMachine::move($subscription, $subscription->status, $subscription->status, [
                'scheduled_plan_id' => $target->id, 'scheduled_interval' => $scheduledInterval,
            ]);
            $open = BillingInvoice::query()->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
            if ($open !== null) {
                $this->invoices->void($open, BillingInvoice::VOID_SUPERSEDED, system: false);
            }
            $this->audit->log('subscription.change_scheduled', $subscription, [
                'from' => $subscription->plan->code, 'to' => $target->code, 'interval' => $scheduledInterval, 'kind' => $kind,
                'effective_at' => $quote['effective_at']->toIso8601ZuluString(),
            ], $user);

            return ['status' => 200, 'subscription' => $subscription->refresh()->load('plan'), 'invoice' => null];
        }));
    }

    /** DELETE /billing/scheduled-change ("Keep Growth"). */
    public function cancelScheduled(Authenticatable $user): Subscription
    {
        $tenant = $this->context->tenant();

        return BillingLock::run($tenant->id, fn () => DB::transaction(function () use ($user) {
            $subscription = $this->current(lock: true);
            if ($subscription->scheduled_plan_id === null) {
                throw new ApiException(404, 'not_found', 'Nothing is scheduled.');
            }
            $scheduled = $subscription->scheduledPlan;
            SubscriptionStateMachine::move($subscription, $subscription->status, $subscription->status, [
                'scheduled_plan_id' => null, 'scheduled_interval' => null,
            ]);
            // A renewal invoice issued for the scheduled plan no longer applies: billing:run re-issues it at today's plan.
            $open = BillingInvoice::query()->where('status', BillingInvoice::OPEN)->where('kind', BillingInvoice::RENEWAL)->lockForUpdate()->first();
            if ($open !== null && ($open->plan_id !== $subscription->plan_id || $open->interval !== $subscription->billing_interval)) {
                $this->invoices->void($open, BillingInvoice::VOID_SUPERSEDED, system: false);
            }
            $this->audit->log('subscription.change_cancelled', $subscription, ['plan' => $subscription->plan->code, 'scheduled' => $scheduled?->code], $user);

            return $subscription->refresh()->load('plan');
        }));
    }

    /**
     * A verified payment paid this invoice (`open → paid` done by the caller): apply it to the subscription (§3.1).
     * `$late` = a voided invoice paid later (P7-14): a new term from now with the invoice's plan and interval.
     * Call under BillingLock inside the transaction.
     */
    public function applyPaidInvoice(BillingInvoice $invoice, bool $late, ?Authenticatable $actor = null): Subscription
    {
        $tenant = $this->context->tenant();
        $subscription = $this->current(lock: true);
        $plan = $invoice->plan;
        $now = now();
        $from = $subscription->plan->code;
        $status = $subscription->status;
        $kind = $late ? BillingInvoice::NEW : $invoice->kind;

        if ($kind === BillingInvoice::RENEWAL) {
            if ($invoice->plan_id === $subscription->plan_id && $invoice->interval === $subscription->billing_interval) {
                $periodStart = $invoice->period_start ?? $subscription->current_period_end ?? $now;
                $periodEnd = $invoice->period_end ?? BillingQuoteService::addInterval($periodStart, $invoice->interval);
                SubscriptionStateMachine::move($subscription, $status, Subscription::ACTIVE, [
                    'current_period_start' => $periodStart, 'current_period_end' => $periodEnd,
                    'past_due_at' => null, 'grace_ends_at' => null,
                ]);
                $this->audit->log('subscription.renewed', $subscription, [
                    'plan' => $plan->code, 'interval' => $invoice->interval, 'period_end' => $periodEnd->toIso8601ZuluString(),
                ], $actor, system: $actor === null);
            }
            // else: the renewal of a scheduled downgrade paid before the period end; billing:run applies it at rollover.
        } else {
            [$periodStart, $periodEnd] = match (true) {
                $kind === BillingInvoice::NEW => [$now->copy(), BillingQuoteService::addInterval(
                    ! $late && $status === Subscription::TRIALING && $subscription->trial_ends_at?->greaterThan($now) ? $subscription->trial_ends_at : $now,
                    $invoice->interval,
                )],
                $invoice->interval !== $subscription->billing_interval => [$now->copy(), BillingQuoteService::addInterval($now, $invoice->interval)],
                default => [$subscription->current_period_start ?? $now->copy(), $subscription->current_period_end ?? BillingQuoteService::addInterval($now, $invoice->interval)],
            };
            SubscriptionStateMachine::move($subscription, $status, Subscription::ACTIVE, [
                'plan_id' => $plan->id, 'billing_interval' => $invoice->interval,
                'current_period_start' => $periodStart, 'current_period_end' => $periodEnd,
                'scheduled_plan_id' => null, 'scheduled_interval' => null, 'past_due_at' => null, 'grace_ends_at' => null,
                'plan_changed_at' => $now,
            ]);
            DB::table('billing_invoices')->where('id', $invoice->id)->where('tenant_id', $invoice->tenant_id)
                ->update(['period_start' => $periodStart, 'period_end' => $periodEnd, 'updated_at' => $now]);
            $invoice->forceFill(['period_start' => $periodStart, 'period_end' => $periodEnd]);
            $this->audit->log('subscription.plan_changed', $subscription, [
                'from' => $from, 'to' => $plan->code, 'interval' => $invoice->interval, 'kind' => $kind, 'late' => $late,
            ], $actor, system: $actor === null);
        }

        $subscription->refresh()->load('plan');
        $this->enforcer->planChanged($tenant, $subscription);

        return $subscription;
    }

    /**
     * past_due → expired (+ a new active Free row) on non-payment (`unpaid`, at grace end) or when the owner picks Free
     * during past_due (`cancelled`). The open renewal invoice is voided; custom domains beyond Free detach at once.
     */
    public function expireToFree(Tenant $tenant, Subscription $subscription, string $reason, ?Authenticatable $actor = null): Subscription
    {
        $now = now();
        $open = BillingInvoice::query()->where('status', BillingInvoice::OPEN)->lockForUpdate()->first();
        if ($open !== null) {
            $this->invoices->void($open, $reason === Subscription::ENDED_UNPAID ? BillingInvoice::VOID_UNPAID : BillingInvoice::VOID_CANCELLED, system: $actor === null);
        }
        $moved = SubscriptionStateMachine::move($subscription, Subscription::PAST_DUE, Subscription::EXPIRED, [
            'ended_at' => $now, 'ended_reason' => $reason, 'cancelled_at' => $reason === Subscription::ENDED_CANCELLED ? $now : null,
            'scheduled_plan_id' => null, 'scheduled_interval' => null, 'cancel_at_period_end' => false,
        ]);
        if (! $moved) {
            return $this->current();
        }
        $free = Subscription::query()->create([
            'plan_id' => Plan::free()->id, 'status' => Subscription::ACTIVE, 'billing_interval' => Plan::MONTH,
            'current_period_start' => $now, 'current_period_end' => $now->copy()->addMonthNoOverflow(),
        ]);
        $free->forceFill(['plan_changed_at' => $now])->save();
        $free->load('plan');
        $this->audit->log('subscription.expired', $subscription, ['reason' => $reason, 'plan' => $subscription->plan->code], $actor, system: $actor === null);
        $this->audit->log('subscription.plan_changed', $free, [
            'from' => $subscription->plan->code, 'to' => Plan::FREE, 'interval' => Plan::MONTH, 'kind' => BillingQuoteService::CANCEL,
        ], $actor, system: $actor === null);
        $this->enforcer->planChanged($tenant, $free, immediate: true);
        $this->notifier->owner(BillingMail::DROPPED_TO_FREE);

        return $free;
    }

    /** Applies the scheduled change at `current_period_end` (billing:run step 4). */
    public function applyScheduled(Tenant $tenant, Subscription $subscription): Subscription
    {
        $target = $subscription->scheduledPlan;
        if ($target === null) {
            return $subscription;
        }
        $interval = $subscription->scheduled_interval ?? Plan::MONTH;
        $from = $subscription->plan->code;
        $now = now();
        $oldEnd = $subscription->current_period_end ?? $now;
        $paidRenewal = BillingInvoice::query()->where('kind', BillingInvoice::RENEWAL)->where('status', BillingInvoice::PAID)
            ->where('subscription_id', $subscription->id)->where('plan_id', $target->id)->where('period_start', $oldEnd)->first();

        $columns = ['plan_id' => $target->id, 'billing_interval' => $interval, 'scheduled_plan_id' => null, 'scheduled_interval' => null,
            'plan_changed_at' => $now];
        if ($target->isFree()) {
            $columns += ['current_period_start' => $now, 'current_period_end' => $now->copy()->addMonthNoOverflow()];
        } elseif ($paidRenewal !== null) {
            $columns += ['current_period_start' => $paidRenewal->period_start, 'current_period_end' => $paidRenewal->period_end];
        }
        SubscriptionStateMachine::move($subscription, $subscription->status, $subscription->status, $columns);
        $this->audit->log('subscription.plan_changed', $subscription, [
            'from' => $from, 'to' => $target->code, 'interval' => $interval, 'kind' => $target->isFree() ? BillingQuoteService::CANCEL : BillingQuoteService::DOWNGRADE,
        ], system: true);
        $subscription->refresh()->load('plan');
        $this->enforcer->planChanged($tenant, $subscription);

        return $subscription;
    }

    public static function periodEndsAt(Subscription $subscription): ?Carbon
    {
        return $subscription->status === Subscription::TRIALING ? $subscription->trial_ends_at : $subscription->current_period_end;
    }
}
