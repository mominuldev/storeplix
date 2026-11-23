<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Domains\Jobs\CheckDomainJob;
use App\Domain\Domains\Jobs\DeleteProviderHostnameJob;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PreTenantLookup;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;

/** PHASE-6-CONTRACT §4.1: add, remove, make primary, re-check, and the reclaim of stale hostnames (P6-6). */
final class DomainService
{
    public const RECHECKS_PER_MINUTE = 6;

    public const RECHECKS_PER_HOUR = 30;

    public function __construct(
        private readonly TenantContext $context,
        private readonly PreTenantLookup $preTenant,
        private readonly AuditLogger $audit,
        private readonly DomainStateMachine $machine,
        private readonly DomainChecker $checker,
        private readonly DomainNotifier $notifier,
    ) {}

    /** P6-4–P6-7. Call inside the store's tenant, outside any transaction (a release switches tenants). */
    public function add(Store $store, string $rawHostname, ?Authenticatable $user): StoreDomain
    {
        $tenant = $this->tenant();
        FeatureGate::assertAllows($tenant, Feature::CustomDomain);
        $host = HostnameInput::normalize($rawHostname);
        // Pre-check before any release (QA L-1); the authoritative check is serialised below (QA L-2).
        FeatureGate::assertWithin($tenant, Limit::CustomDomains);

        $claim = $this->preTenant->domainClaimState($host->hostname);
        if ($claim !== null) {
            if ($claim['store_id'] === $store->id || ! $this->reclaimable($claim)) {
                throw self::taken($claim['store_id'] === $store->id);
            }
            $this->release($claim, $host->hostname);
        }

        $now = now();
        $domain = new StoreDomain;
        $domain->forceFill([
            'store_id' => $store->id,
            'hostname' => $host->hostname,
            'display_hostname' => mb_substr($host->display, 0, 253),
            'type' => StoreDomain::TYPE_CUSTOM,
            'status' => StoreDomain::STATUS_PENDING_VERIFICATION,
            'is_primary' => false,
            'verification_token' => self::newToken(),
            'verification_started_at' => $now,
            'status_changed_at' => $now,
            'next_check_at' => $now,
            'check_attempts' => 0,
            'created_by' => $user?->getAuthIdentifier(),
        ]);
        try {
            DB::transaction(function () use ($store, $tenant, $domain) {
                Store::query()->whereKey($store->id)->lockForUpdate()->first(['id']); // serialises concurrent adds (L-2)
                FeatureGate::assertWithin($tenant, Limit::CustomDomains);
                $domain->save();
            });
        } catch (UniqueConstraintViolationException) {
            throw self::taken(false); // lost a race for the same hostname
        }

        $this->audit->log('domain.added', $domain, ['hostname' => $domain->hostname], $user);
        CheckDomainJob::dispatch($domain->id)->forTenant($domain->tenant_id)->afterCommit();

        return StoreDomain::query()->find($domain->id) ?? $domain;
    }

    /** P6-14 + P6-8: deletes at once (stops routing); the primary falls back to the slug platform row first. */
    public function remove(StoreDomain $domain, ?Authenticatable $user): void
    {
        if ($domain->isPlatform()) {
            throw self::platformLocked();
        }
        $fallback = null;
        DomainLock::run($domain->id, function () use ($domain, &$fallback) {
            DB::transaction(function () use ($domain, &$fallback) {
                // QA M-1: store row first, the same order as makePrimary() and every transition.
                Store::query()->whereKey($domain->store_id)->lockForUpdate()->first(['id']);
                $row = StoreDomain::query()->whereKey($domain->id)->lockForUpdate()->first();
                if ($row === null) {
                    return;
                }
                if ($row->is_primary) {
                    $fallback = $this->machine->fallBackToPlatform($row);
                }
                $row->delete(); // observers: resolver cache + one revalidation including the removed host
            });
        });

        if ($domain->provider_hostname_id !== null) {
            DeleteProviderHostnameJob::dispatch((string) ($domain->provider ?? 'cloudflare'), $domain->provider_hostname_id)->afterCommit();
        }
        $this->audit->log('domain.removed', $domain, ['hostname' => $domain->hostname, 'status' => $domain->status], $user);
        if ($fallback !== null) {
            $this->audit->log('domain.primary_changed', $domain, ['from' => $domain->hostname, 'to' => $fallback, 'reason' => 'removed'], $user);
            $this->notifier->mail($domain->tenant_id, $domain->store_id, DomainStatusMail::PRIMARY_FALLBACK, $domain->hostname, fallbackHost: $fallback);
        }
    }

    /**
     * P6-8: only an active row; demote + promote in one transaction holding the store row.
     *
     * @return list<StoreDomain> the store's domains, ordered
     */
    public function makePrimary(Store $store, StoreDomain $domain, ?Authenticatable $user): array
    {
        if ($domain->status !== StoreDomain::STATUS_ACTIVE) {
            throw new ApiException(409, 'domain_not_active', 'Only a connected domain can be the primary address.');
        }
        if ($domain->isCustom()) {
            FeatureGate::assertAllows($this->tenant(), Feature::CustomDomain);
        }

        $previous = null;
        $changed = DB::transaction(function () use ($store, $domain, &$previous) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first(['id']);
            $row = StoreDomain::query()->whereKey($domain->id)->lockForUpdate()->first();
            if ($row === null || $row->status !== StoreDomain::STATUS_ACTIVE) {
                throw new ApiException(409, 'domain_not_active', 'Only a connected domain can be the primary address.');
            }
            if ($row->is_primary) {
                return false;
            }
            $previous = StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->value('hostname');
            StoreDomain::query()->where('store_id', $store->id)->where('is_primary', true)->update(['is_primary' => false, 'updated_at' => now()]);
            StoreDomain::query()->whereKey($row->id)->where('status', StoreDomain::STATUS_ACTIVE)->update(['is_primary' => true, 'updated_at' => now()]);

            return true;
        });

        if ($changed) {
            $this->audit->log('domain.primary_changed', $domain, ['from' => $previous, 'to' => $domain->hostname, 'reason' => 'merchant'], $user);
            $this->notifier->routingChanged($store->tenant_id, $store->id, array_values(array_filter([$previous, $domain->hostname])));
        }

        return self::listFor($store);
    }

    /**
     * Re-check now (§4.1): from verification_failed/expired first back to pending_verification with a new 72 h window,
     * then the check for the status, synchronously. Errors are recorded on the row, never thrown (no 502).
     * `$throttle = false`: the admin re-check (PHASE-8-1 §4.2), same Action without the merchant cooldown.
     */
    public function recheck(StoreDomain $domain, ?Authenticatable $user, bool $throttle = true): StoreDomain
    {
        if ($domain->isPlatform()) {
            throw self::platformLocked();
        }
        if ($domain->status === StoreDomain::STATUS_SUSPENDED) {
            throw new InvalidDomainTransition(StoreDomain::STATUS_SUSPENDED, StoreDomain::STATUS_PENDING_VERIFICATION);
        }
        // Phase 7 (§2.1 b, S66): reviving a failed/expired (e.g. plan_limit) row needs the feature and room in the plan,
        // counting the row itself; re-checks of pending/active rows stay ungated (Q71).
        if (in_array($domain->status, [StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_EXPIRED], true)) {
            FeatureGate::assertAllows($this->tenant(), Feature::CustomDomain);
            FeatureGate::assertWithin($this->tenant(), Limit::CustomDomains, adding: 0);
        }
        if ($throttle) { // PHASE-8-1 §4.2: the admin re-check ignores the merchant cooldown (admin-write applies)
            $this->throttleRecheck($domain);
        }
        $this->audit->log('domain.recheck_requested', $domain, ['hostname' => $domain->hostname, 'status' => $domain->status], $user);

        return DomainLock::run($domain->id, function () use ($domain, $user) {
            $row = StoreDomain::query()->findOrFail($domain->id);
            if (in_array($row->status, [StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_EXPIRED], true)) {
                $row = $this->machine->transition($row, StoreDomain::STATUS_PENDING_VERIFICATION, [
                    'verification_started_at' => now(),
                    'first_failed_at' => null,
                ], actor: $user, reason: 'recheck') ?? StoreDomain::query()->findOrFail($domain->id);
            }

            return $this->checker->check($row, $user);
        });
    }

    /** @return list<StoreDomain> platform rows first, then custom rows by created_at */
    public static function listFor(Store $store): array
    {
        return StoreDomain::query()->where('store_id', $store->id)
            ->orderByRaw("case when type = 'platform' then 0 else 1 end")
            ->orderBy('created_at')->orderBy('id')
            ->get()->all();
    }

    /** 32 random bytes, base32 lowercase without padding (52 chars), P6-1. */
    public static function newToken(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
        $bits = '';
        foreach (str_split(random_bytes(32)) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= $alphabet[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    /**
     * P6-6 / Q73 as amended by QA H-1: a row is reclaimable when it has been unproven (failed or expired, never proven
     * again since) for more than DOMAINS_RECLAIM_AFTER_DAYS — measured from `unproven_since`, which a merchant re-check
     * does not reset (a failed row that is re-checked back to pending_verification stays reclaimable).
     *
     * @param  array{status: string, unproven_since: string|null}  $claim
     */
    private function reclaimable(array $claim): bool
    {
        $statuses = [StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_EXPIRED, StoreDomain::STATUS_PENDING_VERIFICATION];
        if (! in_array($claim['status'], $statuses, true) || $claim['unproven_since'] === null) {
            return false;
        }

        return CarbonImmutable::parse($claim['unproven_since'])
            ->lessThan(now()->subDays((int) config('domains.reclaim_after_days', 7)));
    }

    /**
     * P6-6 / B20: release a stale row of another store, inside ITS tenant, outside any transaction. The newcomer
     * still has to prove TXT.
     *
     * @param  array{tenant_id: string, store_id: string, domain_id: string}  $claim
     */
    private function release(array $claim, string $hostname): void
    {
        $released = $this->context->run($claim['tenant_id'], function () use ($claim) {
            return DomainLock::run($claim['domain_id'], function () use ($claim) {
                $row = StoreDomain::query()->whereKey($claim['domain_id'])->first();
                if ($row === null) {
                    return null;
                }
                if (! $this->reclaimable(['status' => $row->status, 'unproven_since' => $row->unproven_since?->toIso8601String()])) {
                    throw self::taken(false); // changed since the claim check
                }
                $row->delete();
                $this->audit->log('domain.released', $row, ['hostname' => $row->hostname, 'status' => $row->status], tenantId: $row->tenant_id, system: true);

                return $row;
            });
        });
        if ($released === null) {
            return;
        }
        if ($released->provider_hostname_id !== null) {
            DeleteProviderHostnameJob::dispatch((string) ($released->provider ?? 'cloudflare'), $released->provider_hostname_id);
        }
        $this->notifier->mail($released->tenant_id, $released->store_id, DomainStatusMail::RELEASED, $hostname);
    }

    private function throttleRecheck(StoreDomain $domain): void
    {
        $minute = 'domain-recheck:m:'.$domain->id;
        $hour = 'domain-recheck:h:'.$domain->id;
        foreach ([[$minute, self::RECHECKS_PER_MINUTE], [$hour, self::RECHECKS_PER_HOUR]] as [$key, $max]) {
            if (RateLimiter::tooManyAttempts($key, $max)) {
                throw new ApiException(429, 'rate_limited', 'This domain was checked a moment ago. Try again shortly.', null, max(1, RateLimiter::availableIn($key)));
            }
        }
        RateLimiter::hit($minute, 60);
        RateLimiter::hit($hour, 3600);
    }

    private function tenant(): Tenant
    {
        return $this->context->tenant() ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private static function taken(bool $sameStore): ApiException
    {
        $message = $sameStore ? 'This domain is already connected to your shop.' : 'This domain is connected to another shop.';

        return new ApiException(422, 'domain_taken', $message, ['hostname' => [$message]]);
    }

    private static function platformLocked(): ApiException
    {
        return new ApiException(409, 'platform_domain_locked', 'Your Store Plix address can’t be removed or re-checked.');
    }
}
