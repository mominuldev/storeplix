<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Domains\Events\DomainStatusChanged;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StoreProvisioner;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-6-CONTRACT §2.1 / P6-10: the only writer of store_domains.status for custom rows. Every transition is a
 * conditional `UPDATE … WHERE id = ? AND status = ?` (callers hold DomainLock), sets status_changed_at, writes
 * `domain.status_changed`, fires DomainStatusChanged, and refreshes routing caches. A primary that leaves `active`
 * falls back to the store's slug platform row in the same transaction (P6-8). Affected rows = 0 → someone else moved
 * it first: returns null.
 */
final class DomainStateMachine
{
    public const TRANSITIONS = [
        StoreDomain::STATUS_PENDING_VERIFICATION => [StoreDomain::STATUS_VERIFIED, StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_VERIFIED => [StoreDomain::STATUS_SSL_PROVISIONING, StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_SSL_PROVISIONING => [StoreDomain::STATUS_ACTIVE, StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_ACTIVE => [StoreDomain::STATUS_EXPIRED, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_VERIFICATION_FAILED => [StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_EXPIRED => [StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_SUSPENDED],
        StoreDomain::STATUS_SUSPENDED => [StoreDomain::STATUS_ACTIVE, StoreDomain::STATUS_SSL_PROVISIONING, StoreDomain::STATUS_PENDING_VERIFICATION],
    ];

    /** Statuses where a stale failure is cleared unless the caller sets one. */
    private const CLEARS_FAILURE = [
        StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_VERIFIED, StoreDomain::STATUS_SSL_PROVISIONING, StoreDomain::STATUS_ACTIVE,
    ];

    public function __construct(
        private readonly AuditLogger $audit,
        private readonly DomainNotifier $notifier,
    ) {}

    public static function allowed(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    /**
     * @param  array<string, mixed>  $set  extra columns (already DB-ready values)
     *
     * @throws InvalidDomainTransition
     */
    public function transition(
        StoreDomain $domain,
        string $to,
        array $set = [],
        ?DomainFailureCode $failure = null,
        ?string $failureMessage = null,
        ?Authenticatable $actor = null,
        string $reason = 'check',
    ): ?StoreDomain {
        $from = $domain->status;
        // Phase 7 (§2.3): plan enforcement detaches any custom row except a suspended one (→ expired, `plan_limit`).
        $planDetach = $failure === DomainFailureCode::PlanLimit && $to === StoreDomain::STATUS_EXPIRED
            && $from !== StoreDomain::STATUS_SUSPENDED && $from !== StoreDomain::STATUS_EXPIRED;
        if ($domain->isPlatform() || (! $planDetach && ! self::allowed($from, $to))) {
            throw new InvalidDomainTransition($from, $to);
        }

        $now = now();
        $attributes = [
            'status' => $to,
            'status_changed_at' => $now,
            'updated_at' => $now,
            'check_attempts' => 0,
            'next_check_at' => DomainCadence::afterTransition($to, $now),
        ];
        if ($failure !== null) {
            $attributes['failure_code'] = $failure->value;
            $attributes['failure_message'] = mb_substr($failureMessage ?? $failure->message(), 0, 255);
        } elseif (in_array($to, self::CLEARS_FAILURE, true)) {
            $attributes['failure_code'] = null;
            $attributes['failure_message'] = null;
        }
        // QA H-1: the reclaim clock (P6-6) starts when ownership is first lost/not proven and only a proof resets it.
        if (in_array($to, [StoreDomain::STATUS_VERIFICATION_FAILED, StoreDomain::STATUS_EXPIRED], true)) {
            $attributes['unproven_since'] = $domain->unproven_since ?? $now;
        } elseif ($to === StoreDomain::STATUS_VERIFIED) {
            $attributes['unproven_since'] = null;
        }
        $attributes = $set + $attributes;

        $fallback = null;
        try {
            DB::transaction(function () use ($domain, $from, $to, $attributes, &$fallback) {
                // QA M-1: one lock order everywhere: the store row first, then domain rows.
                Store::query()->whereKey($domain->store_id)->lockForUpdate()->first(['id']);
                if ($to !== StoreDomain::STATUS_ACTIVE && StoreDomain::query()->whereKey($domain->id)->value('is_primary')) {
                    $fallback = $this->fallBackToPlatform($domain); // P6-8 order: demote → promote slug row → status
                }
                $affected = StoreDomain::query()->whereKey($domain->id)->where('status', $from)->update($attributes);
                if ($affected === 0) {
                    throw new LostTransitionRace;
                }
            });
        } catch (LostTransitionRace) {
            return null;
        }

        $this->audit->log('domain.status_changed', $domain, [
            'hostname' => $domain->hostname, 'from' => $from, 'to' => $to, 'failure_code' => $attributes['failure_code'] ?? null,
        ], actor: $actor, tenantId: $domain->tenant_id, system: $actor === null);
        if ($fallback !== null) {
            $this->audit->log('domain.primary_changed', $domain, [
                'from' => $domain->hostname, 'to' => $fallback, 'reason' => $to,
            ], tenantId: $domain->tenant_id, system: true);
            $this->notifier->mail($domain->tenant_id, $domain->store_id, DomainStatusMail::PRIMARY_FALLBACK, $domain->hostname, fallbackHost: $fallback);
        }

        event(new DomainStatusChanged($domain->tenant_id, $domain->store_id, $domain->id, $domain->hostname, $from, $to, $attributes['failure_code'] ?? null));
        $this->notifier->routingChanged($domain->tenant_id, $domain->store_id, array_values(array_filter([$domain->hostname, $fallback])));

        return StoreDomain::query()->find($domain->id);
    }

    /**
     * Moves the store's primary to its slug platform row (`{slug}.{PLATFORM_DOMAIN}`; else its oldest platform row).
     * Must run inside a transaction. Demotes first: the partial unique index and the CHECKs are immediate.
     */
    public function fallBackToPlatform(StoreDomain $domain): ?string
    {
        $store = Store::query()->whereKey($domain->store_id)->lockForUpdate()->first(['id', 'slug']);
        $slugHost = $store !== null ? StoreProvisioner::platformHostname($store->slug) : null;
        $target = StoreDomain::query()->where('store_id', $domain->store_id)->where('type', StoreDomain::TYPE_PLATFORM)
            ->where('status', StoreDomain::STATUS_ACTIVE)->orderBy('created_at')->get(['id', 'hostname'])
            ->sortByDesc(fn (StoreDomain $d) => $d->hostname === $slugHost)->first();

        StoreDomain::query()->whereKey($domain->id)->update(['is_primary' => false, 'updated_at' => now()]);
        if ($target === null) {
            return null;
        }
        StoreDomain::query()->whereKey($target->id)->update(['is_primary' => true, 'updated_at' => now()]);

        return $target->hostname;
    }
}
