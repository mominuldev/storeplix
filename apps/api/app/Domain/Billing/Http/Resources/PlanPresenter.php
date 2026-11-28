<?php

namespace App\Domain\Billing\Http\Resources;

use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\PlanChangeService;

final class PlanPresenter
{
    /** @return array<string, mixed> */
    public static function plan(Plan $plan): array
    {
        $limits = [];
        foreach (Limit::cases() as $limit) {
            $value = $plan->limits[$limit->value] ?? null;
            $limits[$limit->value] = $value === null ? null : (int) $value;
        }

        return [
            'id' => $plan->id,
            'code' => $plan->code,
            'name' => $plan->name,
            'price_amount' => $plan->price_amount,
            'currency' => $plan->currency,
            'interval' => $plan->interval,
            'limits' => $limits,
            'features' => array_values($plan->features ?? []),
            'price_yearly_amount' => $plan->price_yearly_amount,
        ];
    }

    /**
     * Subscription (§9). `open_invoice` only when the caller may see billing (O A).
     *
     * @return array<string, mixed>
     */
    public static function subscription(Subscription $subscription, bool $withInvoice = true): array
    {
        $scheduled = $subscription->scheduled_plan_id !== null ? ($subscription->scheduledPlan ?? Plan::query()->find($subscription->scheduled_plan_id)) : null;
        $open = $withInvoice ? BillingInvoice::query()->subscriptionKinds()->where('status', BillingInvoice::OPEN)->first() : null;

        return [
            'id' => $subscription->id,
            'status' => $subscription->status,
            'plan' => self::plan($subscription->plan),
            'trial_ends_at' => $subscription->trial_ends_at?->toIso8601ZuluString(),
            'current_period_start' => $subscription->current_period_start?->toIso8601ZuluString(),
            'current_period_end' => $subscription->current_period_end?->toIso8601ZuluString(),
            'cancel_at_period_end' => $subscription->cancel_at_period_end,
            'billing_interval' => $subscription->billing_interval ?? Plan::MONTH,
            'scheduled_change' => $scheduled !== null ? [
                'plan' => self::plan($scheduled),
                'interval' => $subscription->scheduled_interval ?? Plan::MONTH,
                'effective_at' => PlanChangeService::periodEndsAt($subscription)?->toIso8601ZuluString(),
            ] : null,
            'past_due_at' => $subscription->past_due_at?->toIso8601ZuluString(),
            'grace_ends_at' => $subscription->grace_ends_at?->toIso8601ZuluString(),
            'domain_grace_ends_at' => $subscription->domain_grace_ends_at?->toIso8601ZuluString(),
            'open_invoice' => $open !== null ? BillingPresenter::invoiceSummary($open) : null,
        ];
    }
}
