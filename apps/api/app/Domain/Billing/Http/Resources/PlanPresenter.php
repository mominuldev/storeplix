<?php

namespace App\Domain\Billing\Http\Resources;

use App\Domain\Billing\Limit;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;

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
        ];
    }

    /** @return array<string, mixed> */
    public static function subscription(Subscription $subscription): array
    {
        return [
            'id' => $subscription->id,
            'status' => $subscription->status,
            'plan' => self::plan($subscription->plan),
            'trial_ends_at' => $subscription->trial_ends_at?->toIso8601ZuluString(),
            'current_period_start' => $subscription->current_period_start?->toIso8601ZuluString(),
            'current_period_end' => $subscription->current_period_end?->toIso8601ZuluString(),
            'cancel_at_period_end' => $subscription->cancel_at_period_end,
        ];
    }
}
