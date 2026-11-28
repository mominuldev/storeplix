<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * `billing:run` per tenant (§4.1, ProcessSubscriptionJob). Runs whatever is due, in order; every step is idempotent
 * (status conditions + `notices` / `reminders` keys), so reruns never double an invoice or an email:
 *  1. trial end → Free (+ trial-ending email at T−3 d);  2. stale new/upgrade invoices → void `expired`;
 *  3. renewal invoice at T−7 d (+ reminders T−3 d, T−1 d);  4. period end: scheduled change, Free roll-over, or past_due;
 *  5. past_due: grace-ending email at grace − 2 d; grace end → expired + Free;  6. domain grace end → detach.
 * Call inside the tenant context.
 */
final class SubscriptionProcessor
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly PlanChangeService $plans,
        private readonly InvoiceService $invoices,
        private readonly DowngradeEnforcer $enforcer,
        private readonly BillingNotifier $notifier,
        private readonly AuditLogger $audit,
    ) {}

    public function process(): void
    {
        $tenant = $this->context->tenant();
        BillingLock::run($tenant->id, function () use ($tenant) {
            $this->trialEnd($tenant);
            $this->staleChangeInvoices();
            $this->renewalInvoice();
            $this->periodEnd($tenant);
            $this->pastDue($tenant);
            $this->domainGrace($tenant);
        });
    }

    /** Step 1. */
    private function trialEnd(Tenant $tenant): void
    {
        $subscription = $this->subscription();
        if ($subscription === null || $subscription->status !== Subscription::TRIALING || $subscription->trial_ends_at === null) {
            return;
        }
        if ($subscription->trial_ends_at->isFuture()) {
            if ($subscription->trial_ends_at->lessThanOrEqualTo(now()->addDays((int) config('billing.trial_reminder_days', 3)))
                && DB::transaction(fn () => BillingNotifier::claimNotice($subscription, 'trial_ending'))) {
                $this->notifier->owner(BillingMail::TRIAL_ENDING, ['date' => BillingNotifier::date($subscription->trial_ends_at)]);
                $this->notifier->ownerSms(PlatformSmsType::PlanExpiring, ['plan' => $subscription->plan->name, 'due_date' => BillingNotifier::date($subscription->trial_ends_at)]);
            }

            return;
        }
        $free = Plan::free();
        $from = $subscription->plan->code;
        $moved = DB::transaction(fn () => SubscriptionStateMachine::move($subscription, Subscription::TRIALING, Subscription::ACTIVE, [
            'plan_id' => $free->id, 'billing_interval' => Plan::MONTH, 'scheduled_plan_id' => null, 'scheduled_interval' => null,
            'current_period_start' => now(), 'current_period_end' => now()->addMonthNoOverflow(), 'plan_changed_at' => now(),
        ]));
        if (! $moved) {
            return;
        }
        $this->audit->log('subscription.trial_ended', $subscription, ['plan' => ['from' => $from, 'to' => $free->code]], system: true);
        $subscription->refresh()->load('plan');
        $this->afterDrop($tenant, $subscription, immediate: false);
    }

    /** Step 2: `new` / `upgrade` invoices are voided after the TTL (their proration is time-based). */
    private function staleChangeInvoices(): void
    {
        $stale = BillingInvoice::query()->where('status', BillingInvoice::OPEN)->whereIn('kind', [BillingInvoice::NEW, BillingInvoice::UPGRADE])
            ->where('issued_at', '<=', now()->subHours((int) config('billing.change_invoice_ttl_hours', 24)))->get();
        foreach ($stale as $invoice) {
            DB::transaction(fn () => $this->invoices->void($invoice, BillingInvoice::VOID_EXPIRED));
        }
    }

    /** Step 3 (+ reminders). */
    private function renewalInvoice(): void
    {
        $subscription = $this->subscription();
        if ($subscription === null || $subscription->status !== Subscription::ACTIVE || $subscription->plan->isFree() || $subscription->current_period_end === null) {
            return;
        }
        $nextPlan = $subscription->scheduledPlan ?? $subscription->plan;
        $nextInterval = $subscription->scheduled_plan_id !== null ? ($subscription->scheduled_interval ?? Plan::MONTH) : $subscription->billing_interval;
        $end = $subscription->current_period_end;
        if ($nextPlan->isFree() || $end->copy()->subDays((int) config('billing.renewal_lead_days', 7))->isFuture()) {
            return;
        }
        $invoice = BillingInvoice::query()->where('kind', BillingInvoice::RENEWAL)->where('subscription_id', $subscription->id)
            ->where('period_start', $end)->where('status', '<>', BillingInvoice::VOID)->first();
        if ($invoice === null) {
            if ($end->isPast()) {
                return; // step 4 handles an overdue period (issues the invoice with past_due)
            }
            $invoice = DB::transaction(fn () => $this->issueRenewal($subscription, $nextPlan, $nextInterval));
            $this->notifier->owner(BillingMail::INVOICE_ISSUED, $this->invoiceMail($invoice, $end));
            $this->notifier->ownerSms(PlatformSmsType::InvoiceIssued, $this->invoiceSms($invoice, $end));

            return;
        }
        if ($invoice->status !== BillingInvoice::OPEN) {
            return;
        }
        foreach ((array) config('billing.reminder_days', [3, 1]) as $days) {
            $key = 't-'.$days;
            if ($end->copy()->subDays((int) $days)->isFuture() || in_array($key, $invoice->reminders ?? [], true)) {
                continue;
            }
            $claimed = DB::transaction(function () use ($invoice, $key) {
                $row = BillingInvoice::query()->whereKey($invoice->id)->lockForUpdate()->first();
                if ($row === null || in_array($key, $row->reminders ?? [], true)) {
                    return false;
                }
                DB::table('billing_invoices')->where('id', $row->id)->where('tenant_id', $row->tenant_id)
                    ->update(['reminders' => json_encode([...($row->reminders ?? []), $key])]);

                return true;
            });
            if ($claimed) {
                $this->notifier->owner(BillingMail::REMINDER, $this->invoiceMail($invoice, $end));
                $this->notifier->ownerSms(PlatformSmsType::PaymentDue, $this->invoiceSms($invoice, $end));
            }
            break; // one reminder per run (the latest due one)
        }
    }

    /** Step 4. */
    private function periodEnd(Tenant $tenant): void
    {
        $subscription = $this->subscription();
        if ($subscription === null || $subscription->status !== Subscription::ACTIVE || $subscription->current_period_end === null
            || $subscription->current_period_end->isFuture()) {
            return;
        }
        if ($subscription->scheduled_plan_id !== null) {
            $wasPaid = ! $subscription->plan->isFree();
            $subscription = DB::transaction(fn () => $this->plans->applyScheduled($tenant, $subscription));
            if ($subscription->plan->isFree()) {
                if ($wasPaid) {
                    $this->afterDrop($tenant, $subscription, immediate: false, mail: false);
                    $this->notifier->owner(BillingMail::DROPPED_TO_FREE);
                }

                return;
            }
            $this->afterDrop($tenant, $subscription, immediate: false, mail: false);
            if ($subscription->current_period_end?->isFuture()) {
                return; // the renewal of the scheduled plan was paid early
            }
        }

        if ($subscription->plan->isFree()) {
            DB::transaction(function () use ($subscription) {
                $start = $subscription->current_period_end;
                $end = $start->copy();
                while ($end->lessThanOrEqualTo(now())) {
                    $start = $end->copy();
                    $end = $end->copy()->addMonthNoOverflow();
                }
                SubscriptionStateMachine::move($subscription, Subscription::ACTIVE, Subscription::ACTIVE, [
                    'current_period_start' => $start, 'current_period_end' => $end,
                ]);
            });

            return;
        }

        // Paid and the period ended unpaid → past_due (the paid plan stays effective, P7-1).
        $end = $subscription->current_period_end;
        $invoice = BillingInvoice::query()->where('kind', BillingInvoice::RENEWAL)->where('subscription_id', $subscription->id)
            ->where('period_start', $end)->where('status', '<>', BillingInvoice::VOID)->first();
        if ($invoice?->status === BillingInvoice::PAID) {
            DB::transaction(fn () => $this->plans->applyPaidInvoice($invoice, false));

            return;
        }
        $graceEnds = $end->copy()->addDays((int) config('billing.grace_days', 7));
        $moved = DB::transaction(function () use ($subscription, $invoice, $graceEnds) {
            if ($invoice === null) {
                $invoice = $this->issueRenewal($subscription, $subscription->plan, $subscription->billing_interval);
            }

            return SubscriptionStateMachine::move($subscription, Subscription::ACTIVE, Subscription::PAST_DUE, [
                'past_due_at' => now(), 'grace_ends_at' => $graceEnds,
            ]) ? $invoice : null;
        });
        if ($moved === null) {
            return;
        }
        $this->audit->log('subscription.past_due', $subscription, ['plan' => $subscription->plan->code, 'invoice' => $moved->number,
            'grace_ends_at' => $graceEnds->toIso8601ZuluString()], system: true);
        $this->notifier->owner(BillingMail::PAST_DUE, [
            'plan' => $subscription->plan->name, 'number' => $moved->number, 'date' => BillingNotifier::date($graceEnds),
        ]);
        $this->notifier->ownerSms(PlatformSmsType::PaymentDue, $this->invoiceSms($moved, $graceEnds));
    }

    /** Step 5. */
    private function pastDue(Tenant $tenant): void
    {
        $subscription = $this->subscription();
        if ($subscription === null || $subscription->status !== Subscription::PAST_DUE || $subscription->grace_ends_at === null) {
            return;
        }
        if ($subscription->grace_ends_at->isFuture()) {
            if ($subscription->grace_ends_at->lessThanOrEqualTo(now()->addDays((int) config('billing.grace_reminder_days', 2)))
                && DB::transaction(fn () => BillingNotifier::claimNotice($subscription, 'grace_ending:'.$subscription->grace_ends_at->getTimestamp()))) {
                $open = BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::OPEN)->first();
                $this->notifier->owner(BillingMail::GRACE_ENDING, [
                    'plan' => $subscription->plan->name, 'number' => $open?->number, 'date' => BillingNotifier::date($subscription->grace_ends_at),
                ]);
                $this->notifier->ownerSms(PlatformSmsType::PlanExpiring, ['plan' => $subscription->plan->name, 'due_date' => BillingNotifier::date($subscription->grace_ends_at)]);
            }

            return;
        }
        DB::transaction(fn () => $this->plans->expireToFree($tenant, $subscription, Subscription::ENDED_UNPAID));
    }

    /** Step 6. */
    private function domainGrace(Tenant $tenant): void
    {
        $subscription = $this->subscription();
        if ($subscription === null || $subscription->domain_grace_ends_at === null || $subscription->domain_grace_ends_at->isFuture()) {
            return;
        }
        $this->enforcer->detachExcess($tenant);
        DB::table('subscriptions')->where('id', $subscription->id)->where('tenant_id', $subscription->tenant_id)
            ->update(['domain_grace_ends_at' => null, 'updated_at' => now()]);
        FeatureGate::forget($tenant->id);
    }

    /** After the effective plan dropped (trial end, scheduled downgrade/cancel): domain grace + emails. */
    private function afterDrop(Tenant $tenant, Subscription $subscription, bool $immediate, bool $mail = true): void
    {
        $grace = $this->enforcer->planChanged($tenant, $subscription, $immediate);
        if ($grace !== null && $grace->isFuture() && DB::transaction(fn () => BillingNotifier::claimNotice($subscription, 'domain_grace:'.$grace->getTimestamp()))) {
            $this->notifier->owner(BillingMail::DOMAIN_WILL_DETACH, ['date' => BillingNotifier::date($grace)]);
        }
        if ($mail && $subscription->plan->isFree()) {
            $this->notifier->owner(BillingMail::DROPPED_TO_FREE);
        }
    }

    private function issueRenewal(Subscription $subscription, Plan $plan, string $interval): BillingInvoice
    {
        $start = $subscription->current_period_end;
        $end = BillingQuoteService::addInterval($start, $interval);
        $price = (int) $plan->priceFor($interval);

        return $this->invoices->issue($subscription, BillingInvoice::RENEWAL, $plan, $interval, $price, 0,
            [BillingQuoteService::line(BillingQuoteService::planDescription($plan, $interval), $plan, $interval, $start, $end, $price)],
            $start, $end, $start->copy());
    }

    /** @return array<string, string|null> */
    private function invoiceMail(BillingInvoice $invoice, Carbon $date): array
    {
        return ['number' => $invoice->number, 'amount' => Money::bdt($invoice->total_amount), 'plan' => $invoice->plan->name, 'date' => BillingNotifier::date($date)];
    }

    /** PHASE-8-9B §5 SMS vars (amount "1,770", due date "5 Dec 2026"). @return array<string, string> */
    private function invoiceSms(BillingInvoice $invoice, Carbon $date): array
    {
        return ['invoice_no' => (string) $invoice->number, 'amount' => Money::plain((int) $invoice->total_amount), 'plan' => (string) $invoice->plan?->name,
            'due_date' => BillingNotifier::date($date)];
    }

    private function subscription(): ?Subscription
    {
        return Subscription::query()->with(['plan', 'scheduledPlan'])->whereIn('status', Subscription::CURRENT_STATUSES)->latest()->first();
    }
}
