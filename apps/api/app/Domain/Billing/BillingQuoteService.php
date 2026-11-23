<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Carbon;

/**
 * PHASE-7-CONTRACT §3.3 (classification) and P7-6 (pricing). Pure functions of the current subscription, the target
 * plan/interval and the clock; no side effects (POST /billing/quote and change-plan share them, so the amounts match).
 */
final class BillingQuoteService
{
    public const NEW = 'new';

    public const UPGRADE = 'upgrade';

    public const DOWNGRADE = 'downgrade';

    public const CANCEL = 'cancel';

    public const UNCHANGED = 'unchanged';

    /** Features with a module enforced today (§2.1) → their merchant-facing name, used in downgrade warnings. */
    public const FEATURE_LABELS = [
        'bulk_courier_booking' => 'Bulk courier booking',
        'profit_reports' => 'Profit & loss reports',
    ];

    /**
     * The change kind (P7-5). Throws 409 plan_unchanged / invoice_overdue and 422 plan_unavailable.
     *
     * @param  string  $status  subscription status
     */
    public static function classify(Plan $current, string $currentInterval, string $status, Plan $target, string $targetInterval): string
    {
        if (! $target->is_active || ! in_array($targetInterval, Plan::INTERVALS, true) || $target->priceFor($targetInterval) === null) {
            throw self::unavailable($target->code, 'This plan is not available with that billing interval.');
        }
        if ($status === Subscription::PAST_DUE) {
            if ($target->isFree()) {
                return self::CANCEL;
            }
            throw new ApiException(409, 'invoice_overdue', 'Pay the overdue invoice first, or switch to Free.');
        }

        $trialing = $status === Subscription::TRIALING;
        if ($trialing || $current->isFree()) {
            if ($target->isFree()) {
                if ($trialing) {
                    return self::CANCEL; // the trial ends on Free anyway (applied at trial end)
                }
                throw new ApiException(409, 'plan_unchanged', 'You are already on this plan.');
            }

            return self::NEW;
        }

        if ($target->isFree()) {
            return self::CANCEL;
        }
        if ($target->id === $current->id && $targetInterval === $currentInterval) {
            throw new ApiException(409, 'plan_unchanged', 'You are already on this plan.');
        }
        if ($target->sort > $current->sort) {
            if ($currentInterval === Plan::YEAR && $targetInterval === Plan::MONTH) {
                throw self::unavailable($target->code, "Switch to {$target->name} yearly, or change at renewal.");
            }

            return self::UPGRADE;
        }
        if ($target->sort < $current->sort) {
            return self::DOWNGRADE;
        }

        // Same plan, other interval.
        return $targetInterval === Plan::YEAR ? self::UPGRADE : self::DOWNGRADE;
    }

    /**
     * The full quote (BillingQuote, §9) for the tenant's current subscription.
     *
     * @return array{kind: string, plan: Plan, interval: string, amount: int, credit_amount: int, requires_payment: bool,
     *     effective_at: Carbon, period_start: Carbon|null, period_end: Carbon|null, lines: list<array<string, mixed>>,
     *     warnings: list<array<string, mixed>>}
     */
    public static function quote(Tenant $tenant, Subscription $subscription, Plan $target, string $interval, ?Carbon $now = null): array
    {
        $now ??= now();
        $current = $subscription->plan;
        $kind = self::classify($current, $subscription->billing_interval, $subscription->status, $target, $interval);
        $price = (int) $target->priceFor($interval);
        $credit = 0;
        $lines = [];

        switch ($kind) {
            case self::NEW:
                $amount = $price;
                $start = $now->copy();
                $base = $subscription->status === Subscription::TRIALING && $subscription->trial_ends_at?->greaterThan($now)
                    ? $subscription->trial_ends_at->copy() : $now->copy();
                $end = self::addInterval($base, $interval);
                $lines[] = self::line(self::planDescription($target, $interval), $target, $interval, $start, $end, $amount);
                $effective = $now->copy();
                break;

            case self::UPGRADE:
                [$periodStart, $periodEnd] = self::currentPeriod($subscription, $now);
                $remaining = max(0, $periodEnd->getTimestamp() - $now->getTimestamp());
                $period = max(1, $periodEnd->getTimestamp() - $periodStart->getTimestamp());
                if ($subscription->billing_interval === $interval) {
                    $diff = max(0, $price - (int) $current->priceFor($interval));
                    $amount = max(100, self::ceilToTaka($diff * $remaining, $period));
                    $start = $now->copy();
                    $end = $periodEnd->copy();
                    $lines[] = self::line("Upgrade to {$target->name} for the rest of this period", $target, $interval, $start, $end, $amount);
                } else { // month → year: a new yearly period with a credit for the unused month
                    $unused = intdiv((int) $current->priceFor($subscription->billing_interval) * $remaining, $period);
                    $amount = max(100, self::ceilToTaka(max(0, $price - $unused), 1));
                    $credit = $price - $amount;
                    $start = $now->copy();
                    $end = self::addInterval($now, $interval);
                    $lines[] = self::line(self::planDescription($target, $interval), $target, $interval, $start, $end, $price);
                    if ($credit > 0) {
                        $lines[] = self::line("Credit for unused time on {$current->name} (".self::intervalLabel($subscription->billing_interval).')', null, null, null, null, -$credit);
                    }
                }
                $effective = $now->copy();
                break;

            default: // downgrade | cancel: at period end, no charge, no refund
                $amount = 0;
                $effective = $subscription->status === Subscription::PAST_DUE ? $now->copy()
                    : ($subscription->status === Subscription::TRIALING ? ($subscription->trial_ends_at ?? $now)->copy()
                        : ($subscription->current_period_end ?? $now)->copy());
                $start = $effective->copy();
                $end = self::addInterval($start, $target->isFree() ? Plan::MONTH : $interval);
                $lines[] = self::line(self::planDescription($target, $target->isFree() ? Plan::MONTH : $interval), $target, $interval, $start, $end, 0);
                break;
        }

        return [
            'kind' => $kind,
            'plan' => $target,
            'interval' => $interval,
            'amount' => $amount,
            'credit_amount' => $credit,
            'requires_payment' => $amount > 0,
            'effective_at' => $effective,
            'period_start' => $start,
            'period_end' => $end,
            'lines' => $lines,
            'warnings' => in_array($kind, [self::DOWNGRADE, self::CANCEL], true) ? self::warnings($tenant, $current, $target, $effective) : [],
        ];
    }

    /** ceil(numerator / denominator) rounded UP to whole taka (100 paisa), all integers. */
    public static function ceilToTaka(int $numerator, int $denominator): int
    {
        $unit = $denominator * 100;

        return intdiv($numerator + $unit - 1, $unit) * 100;
    }

    public static function addInterval(Carbon $from, string $interval): Carbon
    {
        return $interval === Plan::YEAR ? $from->copy()->addYearNoOverflow() : $from->copy()->addMonthNoOverflow();
    }

    public static function planDescription(Plan $plan, string $interval): string
    {
        return "Storeplix {$plan->name} plan (".self::intervalLabel($interval).')';
    }

    public static function intervalLabel(string $interval): string
    {
        return $interval === Plan::YEAR ? 'yearly' : 'monthly';
    }

    /** @return array{0: Carbon, 1: Carbon} */
    private static function currentPeriod(Subscription $subscription, Carbon $now): array
    {
        $end = $subscription->current_period_end ?? self::addInterval($now, $subscription->billing_interval);
        $start = $subscription->current_period_start ?? $end->copy()->sub($subscription->billing_interval === Plan::YEAR ? '1 year' : '1 month');

        return [$start->copy(), $end->copy()];
    }

    /** @return array<string, mixed> BillingInvoiceLine */
    public static function line(string $description, ?Plan $plan, ?string $interval, ?Carbon $start, ?Carbon $end, int $amount): array
    {
        return [
            'description' => $description,
            'plan_code' => $plan?->code,
            'interval' => $plan !== null ? $interval : null,
            'period_start' => $start?->toIso8601ZuluString(),
            'period_end' => $end?->toIso8601ZuluString(),
            'quantity' => 1,
            'unit_amount' => $amount,
            'amount' => $amount,
        ];
    }

    /**
     * What the target plan won't cover (BillingDowngradeWarning[]): limits already above the target and lost features.
     *
     * @return list<array{key: string, used: int|null, limit: int|null, message: string}>
     */
    public static function warnings(Tenant $tenant, Plan $current, Plan $target, Carbon $effective): array
    {
        $warnings = [];
        $date = $effective->copy()->timezone('Asia/Dhaka')->format('j M');
        foreach (Limit::cases() as $limit) {
            $allowed = $target->limits[$limit->value] ?? null;
            if ($limit === Limit::CustomDomains && ! in_array(Feature::CustomDomain->value, $target->features ?? [], true)) {
                $allowed = 0;
            }
            if ($allowed === null) {
                continue;
            }
            $used = FeatureGate::usage($tenant, $limit);
            if ($used <= (int) $allowed) {
                continue;
            }
            $label = str_replace('_', ' ', $limit->value);
            $message = $limit === Limit::CustomDomains
                ? "Custom domains above {$target->name}'s limit stop working ".((int) config('billing.domain_grace_days', 7))." days after {$date}."
                : "You have {$used} {$label}; {$target->name} allows {$allowed}. Existing items keep working, but you can't add more.";
            $warnings[] = ['key' => $limit->value, 'used' => $used, 'limit' => (int) $allowed, 'message' => $message];
        }
        // QA L-1: only lost features that have a built, enforced module (§2.1); `key` is the stable FeatureKey, `message` is
        // human copy. Features without a module yet (pos, api_webhooks, …) and those expressed by a limit row are omitted.
        foreach (array_diff($current->features ?? [], $target->features ?? []) as $feature) {
            $label = self::FEATURE_LABELS[$feature] ?? null;
            if ($label === null) {
                continue;
            }
            $warnings[] = ['key' => $feature, 'used' => null, 'limit' => null, 'message' => "{$label} is not included in {$target->name}."];
        }

        return $warnings;
    }

    private static function unavailable(string $code, string $message): ApiException
    {
        return new ApiException(422, 'plan_unavailable', $message, ['plan_code' => [$message]]);
    }
}
