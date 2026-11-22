<?php

namespace App\Domain\Billing;

use App\Domain\Billing\Exceptions\FeatureNotInPlan;
use App\Domain\Billing\Exceptions\PlanLimitReached;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Product;
use App\Domain\Staff\SeatCounter;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;

/**
 * The ONLY way to check what a tenant's plan allows.
 *
 * Effective plan = plan of the current (trialing|active|past_due) subscription, else "free".
 * Resolved plan data is cached per tenant for 60 s (TenantCache key "billing:plan") and
 * busted whenever a subscription changes (SubscriptionObserver).
 */
final class FeatureGate
{
    public const CACHE_KEY = 'billing:plan';

    public static function allows(Tenant $tenant, Feature $feature): bool
    {
        return in_array($feature->value, self::plan($tenant)['features'], true);
    }

    public static function limit(Tenant $tenant, Limit $limit): ?int
    {
        $value = self::plan($tenant)['limits'][$limit->value] ?? null;

        return $value === null ? null : (int) $value;
    }

    /**
     * Live usage. staff_seats (Phase 2); products = non-deleted products of every status (Phase 4, P4-21 / Q29).
     * Other limits return 0 until their module exists.
     */
    public static function usage(Tenant $tenant, Limit $limit): int
    {
        return match ($limit) {
            Limit::StaffSeats => app(SeatCounter::class)->used($tenant),
            Limit::Products => app(TenantContext::class)->run($tenant, fn () => Product::query()->count()),
            default => 0,
        };
    }

    public static function assertWithin(Tenant $tenant, Limit $limit, int $adding = 1): void
    {
        $max = self::limit($tenant, $limit);

        if ($max !== null && self::usage($tenant, $limit) + $adding > $max) {
            throw new PlanLimitReached($limit, $max);
        }
    }

    public static function assertAllows(Tenant $tenant, Feature $feature): void
    {
        if (! self::allows($tenant, $feature)) {
            throw new FeatureNotInPlan($feature);
        }
    }

    public static function forget(string $tenantId): void
    {
        app(TenantContext::class)->run($tenantId, fn () => app(TenantCache::class)->forget(self::CACHE_KEY));
    }

    /**
     * @return array{code: string, features: list<string>, limits: array<string, int|null>, status: string, trial_ends_at: string|null}
     */
    public static function plan(Tenant $tenant): array
    {
        return app(TenantContext::class)->run($tenant, fn () => app(TenantCache::class)->remember(self::CACHE_KEY, 60, function () {
            $subscription = self::currentSubscription();
            $plan = $subscription?->plan ?? Plan::query()->where('code', Plan::FREE)->first();

            return [
                'code' => $plan?->code ?? Plan::FREE,
                'features' => array_values($plan?->features ?? []),
                'limits' => $plan?->limits ?? [],
                'status' => $subscription?->status ?? Subscription::ACTIVE,
                'trial_ends_at' => $subscription?->trial_ends_at?->toIso8601ZuluString(),
            ];
        }));
    }

    /** Must be called inside the tenant's context. */
    public static function currentSubscription(): ?Subscription
    {
        return Subscription::query()
            ->with('plan')
            ->whereIn('status', Subscription::CURRENT_STATUSES)
            ->latest()
            ->first();
    }
}
