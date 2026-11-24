<?php

namespace App\Domain\Billing;

use App\Domain\Billing\Exceptions\FeatureNotInPlan;
use App\Domain\Billing\Exceptions\PlanLimitReached;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Product;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Staff\SeatCounter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Carbon;

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
     * Live usage. staff_seats (Phase 2); products = non-deleted products of every status (Phase 4, P4-21 / Q29);
     * orders_per_month = orders placed this calendar month in the store timezone, any status (P5-27);
     * sms_per_month = order SMS (purpose order_*, not failed) this month (P5-26); courier_connections = connected courier accounts (P5B-31);
     * custom_domains = custom store_domains rows in any status (P6-7); campaign_* = CampaignAllowance (P85-13). Phase 7 (§2.1 d): every Limit case has a module;
     * an unknown key would return 0.
     */
    public static function usage(Tenant $tenant, Limit $limit): int
    {
        return match ($limit) {
            Limit::StaffSeats => app(SeatCounter::class)->used($tenant),
            Limit::Products => app(TenantContext::class)->run($tenant, fn () => Product::query()->count()),
            Limit::OrdersPerMonth => app(TenantContext::class)->run($tenant, fn () => Order::query()->where('placed_at', '>=', self::monthStart())->count()),
            Limit::SmsPerMonth => app(TenantContext::class)->run($tenant, fn () => SmsMessage::query()->where('tenant_id', $tenant->getKey())
                ->whereIn('purpose', SmsTemplates::EVENTS)->where('status', '<>', 'failed')->where('created_at', '>=', self::monthStart())->count()),
            // 5b-3 (P5B-31): connected (or erroring) courier accounts; disconnected rows don't count.
            Limit::CourierConnections => app(TenantContext::class)->run($tenant, fn () => CourierAccount::query()
                ->whereIn('status', [CourierAccount::CONNECTED, CourierAccount::ERROR])->count()),
            // Phase 6 (P6-7): custom domain rows of the (single) store in any status; platform rows don't count.
            Limit::CustomDomains => app(TenantContext::class)->run($tenant, fn () => StoreDomain::query()
                ->where('type', StoreDomain::TYPE_CUSTOM)->count()),
            // Phase 8.5 (P85-13, §2.2): campaign SMS parts / emails this month (recipients sent|sending|unknown + test sends).
            Limit::CampaignSmsPerMonth => app(TenantContext::class)->run($tenant, fn () => CampaignAllowance::used('sms')),
            Limit::CampaignEmailsPerMonth => app(TenantContext::class)->run($tenant, fn () => CampaignAllowance::used('email')),
            default => 0,
        };
    }

    /** Start of the current calendar month in the (single) store's timezone, as UTC. Call inside the tenant context. */
    public static function monthStart(): Carbon
    {
        $timezone = Store::query()->value('timezone') ?: 'Asia/Dhaka';

        return now($timezone)->startOfMonth()->utc();
    }

    public static function assertWithin(Tenant $tenant, Limit $limit, int $adding = 1): void
    {
        $max = self::limit($tenant, $limit);

        if ($max !== null && ($used = self::usage($tenant, $limit)) + $adding > $max) {
            throw new PlanLimitReached($limit, $max, self::upgradePlanForLimit($limit, $used + $adding));
        }
    }

    public static function assertAllows(Tenant $tenant, Feature $feature): void
    {
        if (! self::allows($tenant, $feature)) {
            throw new FeatureNotInPlan($feature, self::upgradePlanForFeature($feature));
        }
    }

    /** P7-17: the cheapest active plan (by sort) whose limit is unlimited or ≥ $needed; null when none qualifies. */
    public static function upgradePlanForLimit(Limit $limit, int $needed): ?string
    {
        foreach (Plan::query()->where('is_active', true)->orderBy('sort')->get(['code', 'limits', 'features']) as $plan) {
            if ($plan->code === Plan::FREE) {
                continue;
            }
            $value = $plan->limits[$limit->value] ?? null;
            if ($value === null || (int) $value >= $needed) {
                return $plan->code;
            }
        }

        return null;
    }

    /** P7-17: the cheapest active plan (by sort) that includes the feature. */
    public static function upgradePlanForFeature(Feature $feature): ?string
    {
        foreach (Plan::query()->where('is_active', true)->orderBy('sort')->get(['code', 'features']) as $plan) {
            if (in_array($feature->value, $plan->features ?? [], true)) {
                return $plan->code;
            }
        }

        return null;
    }

    public static function forget(string $tenantId): void
    {
        app(TenantContext::class)->run($tenantId, fn () => app(TenantCache::class)->forget(self::CACHE_KEY));
    }

    /**
     * @return array{code: string, features: list<string>, limits: array<string, int|null>, status: string, trial_ends_at: string|null, grace_ends_at?: string|null, domain_grace_ends_at?: string|null}
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
                'grace_ends_at' => $subscription?->status === Subscription::PAST_DUE ? $subscription->grace_ends_at?->toIso8601ZuluString() : null,
                'domain_grace_ends_at' => $subscription?->domain_grace_ends_at?->toIso8601ZuluString(),
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
