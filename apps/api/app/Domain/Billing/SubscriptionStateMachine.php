<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Exceptions\InvalidSubscriptionTransition;
use App\Domain\Billing\Models\Subscription;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-7-CONTRACT §3.1: the only writer of `subscriptions.status` after creation. Every change is a conditional
 * `UPDATE … WHERE id = ? AND status = ?` run by the caller under BillingLock and inside a transaction; 0 affected rows
 * = somebody else moved it first (returns false, no side effects). `cancelled` stays reserved for tenant closure.
 * Every successful write busts the FeatureGate plan cache (conditional updates fire no model events).
 */
final class SubscriptionStateMachine
{
    /** @var array<string, list<string>> */
    public const TRANSITIONS = [
        Subscription::TRIALING => [Subscription::TRIALING, Subscription::ACTIVE],
        Subscription::ACTIVE => [Subscription::ACTIVE, Subscription::PAST_DUE],
        Subscription::PAST_DUE => [Subscription::ACTIVE, Subscription::EXPIRED],
        Subscription::EXPIRED => [],
        Subscription::CANCELLED => [],
    ];

    public static function can(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    /**
     * @param  array<string, mixed>  $columns  extra columns (Carbon / scalars; arrays are JSON-encoded)
     *
     * @throws InvalidSubscriptionTransition
     */
    public static function move(Subscription $subscription, string $from, string $to, array $columns = []): bool
    {
        if (! self::can($from, $to)) {
            throw new InvalidSubscriptionTransition($from, $to);
        }
        $now = now();
        $values = ['status' => $to, 'updated_at' => $now] + array_map(fn ($v) => is_array($v) ? json_encode($v) : $v, $columns);
        if ($to === Subscription::ACTIVE) {
            $values['cancel_at_period_end'] = array_key_exists('scheduled_plan_id', $columns)
                ? self::cancelsAtPeriodEnd($columns['scheduled_plan_id'])
                : ($values['cancel_at_period_end'] ?? $subscription->cancel_at_period_end);
        }
        $affected = DB::table('subscriptions')->where('id', $subscription->id)->where('tenant_id', $subscription->tenant_id)
            ->where('status', $from)->update($values);
        if ($affected !== 1) {
            return false;
        }
        $subscription->refresh();
        FeatureGate::forget($subscription->tenant_id);

        return true;
    }

    /** `cancel_at_period_end` mirrors "the scheduled plan is Free" (§3.1). */
    public static function cancelsAtPeriodEnd(?string $scheduledPlanId): bool
    {
        return $scheduledPlanId !== null && DB::table('plans')->where('id', $scheduledPlanId)->value('code') === Models\Plan::FREE;
    }
}
