<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Models\Subscription;
use App\Domain\Domains\DomainFailureCode;
use App\Domain\Domains\DomainLock;
use App\Domain\Domains\DomainStateMachine;
use App\Domain\Domains\Jobs\DeleteProviderHostnameJob;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * P7-16 / §2.3 (resolves Q71): when the effective plan drops nothing is deleted, hidden or disabled; creates above the
 * new limits get 402 (FeatureGate). Only custom domains beyond the plan are detached, after a grace stored on the
 * subscription (`domain_grace_ends_at`): 7 days, or at once after a non-payment expiry. Call in the tenant context.
 */
final class DowngradeEnforcer
{
    public function __construct(private readonly DomainStateMachine $domains) {}

    /** Custom domains the plan allows (0 without the custom_domain feature). */
    public static function allowedDomains(Tenant $tenant): int
    {
        if (! FeatureGate::allows($tenant, Feature::CustomDomain)) {
            return 0;
        }

        return FeatureGate::limit($tenant, Limit::CustomDomains) ?? PHP_INT_MAX;
    }

    /** @return Collection<int, StoreDomain> custom rows that still route or try to (not expired, not suspended), in keep order */
    public static function liveCustomDomains(): Collection
    {
        return StoreDomain::query()->where('type', StoreDomain::TYPE_CUSTOM)
            ->whereNotIn('status', [StoreDomain::STATUS_EXPIRED, StoreDomain::STATUS_SUSPENDED])
            ->get()
            ->sortBy(fn (StoreDomain $d) => [
                $d->is_primary ? 0 : 1,
                $d->status === StoreDomain::STATUS_ACTIVE ? 0 : 1,
                $d->status === StoreDomain::STATUS_ACTIVE ? (string) $d->activated_at?->getTimestamp() : (string) $d->created_at?->getTimestamp(),
                $d->id,
            ])->values();
    }

    /**
     * After any change of the effective plan: set (or clear) the domain grace. $immediate = non-payment expiry.
     * Returns the grace end (null = nothing to detach).
     */
    public function planChanged(Tenant $tenant, Subscription $subscription, bool $immediate = false): ?Carbon
    {
        FeatureGate::forget($tenant->id);
        $excess = self::liveCustomDomains()->count() > self::allowedDomains($tenant);
        $grace = null;
        if ($excess) {
            $grace = $immediate ? now() : ($subscription->domain_grace_ends_at !== null && $subscription->domain_grace_ends_at->isFuture()
                ? $subscription->domain_grace_ends_at : now()->addDays((int) config('billing.domain_grace_days', 7)));
        }
        DB::table('subscriptions')->where('id', $subscription->id)->where('tenant_id', $subscription->tenant_id)
            ->update(['domain_grace_ends_at' => $grace, 'updated_at' => now()]);
        $subscription->domain_grace_ends_at = $grace;
        FeatureGate::forget($tenant->id);

        return $grace;
    }

    /**
     * At `domain_grace_ends_at`: moves the custom rows beyond the plan to `expired` (`plan_limit`): the primary custom
     * row is kept first, then active rows by activation, then the rest by creation. Returns the detached hostnames.
     *
     * @return list<string>
     */
    public function detachExcess(Tenant $tenant): array
    {
        FeatureGate::forget($tenant->id);
        $allowed = self::allowedDomains($tenant);
        $detached = [];
        foreach (self::liveCustomDomains()->slice($allowed) as $domain) {
            DomainLock::run($domain->id, function () use ($domain, &$detached) {
                $row = StoreDomain::query()->find($domain->id);
                if ($row === null || in_array($row->status, [StoreDomain::STATUS_EXPIRED, StoreDomain::STATUS_SUSPENDED], true)) {
                    return;
                }
                $providerId = $row->provider_hostname_id;
                $done = $this->domains->transition($row, StoreDomain::STATUS_EXPIRED, ['provider_hostname_id' => null], DomainFailureCode::PlanLimit, reason: 'plan');
                if ($done !== null) {
                    $detached[] = $row->hostname;
                    if ($providerId !== null) {
                        DeleteProviderHostnameJob::dispatch((string) ($row->provider ?? 'cloudflare'), $providerId);
                    }
                }
            });
        }

        return $detached;
    }
}
