<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Staff\Models\StaffInvitation;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Support\Facades\DB;

/**
 * The request-path lookups that must run BEFORE a tenant is known (PHASE-5B-CONTRACT §2.4 B1, B4, B5; P5B-4/P5B-8).
 * Each returns ids only; the caller then works inside TenantContext::run().
 *
 * With RLS on they call SECURITY DEFINER functions owned by storeplix_owner (no request path holds a BYPASSRLS
 * connection). With RLS off (sqlite, dev, the owner-run api-postgres job) they are the pre-5b app-level opt-outs.
 */
class PreTenantLookup
{
    public function __construct(private readonly RlsSession $rls) {}

    /** B1: an ACTIVE domain of a non-suspended store. @return array{tenant_id: string, store_id: string}|null */
    public function resolveHost(string $host): ?array
    {
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select tenant_id, store_id from sp_resolve_host(?)', [$host]);

            return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id];
        }

        $domain = StoreDomain::withoutTenancy()
            ->where('hostname', $host)
            ->where('status', StoreDomain::STATUS_ACTIVE)
            ->first(['tenant_id', 'store_id']);

        if ($domain === null) {
            return null;
        }

        $storeIsServable = Store::withoutTenancy()
            ->whereKey($domain->store_id)
            ->where('tenant_id', $domain->tenant_id)
            ->where('status', '!=', Store::STATUS_SUSPENDED)
            ->exists();

        return $storeIsServable ? ['tenant_id' => (string) $domain->tenant_id, 'store_id' => (string) $domain->store_id] : null;
    }

    /** B4: invitation by its sha256 token hash. @return array{invitation_id: string, tenant_id: string}|null */
    public function invitationByTokenHash(string $hash): ?array
    {
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select invitation_id, tenant_id from sp_invitation_by_token(?)', [$hash]);

            return $row === null ? null : ['invitation_id' => (string) $row->invitation_id, 'tenant_id' => (string) $row->tenant_id];
        }

        $row = StaffInvitation::withoutTenancy()->where('token_hash', $hash)->first(['id', 'tenant_id']);

        return $row === null ? null : ['invitation_id' => (string) $row->id, 'tenant_id' => (string) $row->tenant_id];
    }

    /**
     * B17 (Phase 6, P6-6): who holds a hostname, across tenants (add-domain uniqueness and reclaim). Ids only.
     *
     * @return array{tenant_id: string, store_id: string, domain_id: string, status: string, status_changed_at: string|null, unproven_since: string|null}|null
     */
    public function domainClaimState(string $host): ?array
    {
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select tenant_id, store_id, domain_id, status, status_changed_at, unproven_since from sp_domain_claim_state(?)', [$host]);

            return $row === null ? null : [
                'tenant_id' => trim((string) $row->tenant_id), 'store_id' => trim((string) $row->store_id),
                'domain_id' => trim((string) $row->domain_id), 'status' => (string) $row->status,
                'status_changed_at' => $row->status_changed_at !== null ? (string) $row->status_changed_at : null,
                'unproven_since' => $row->unproven_since !== null ? (string) $row->unproven_since : null,
            ];
        }

        $row = StoreDomain::withoutTenancy()->where('hostname', $host)->first(['id', 'tenant_id', 'store_id', 'status', 'status_changed_at', 'unproven_since']);

        return $row === null ? null : [
            'tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id, 'domain_id' => (string) $row->id,
            'status' => (string) $row->status, 'status_changed_at' => $row->status_changed_at?->toIso8601String(),
            'unproven_since' => $row->unproven_since?->toIso8601String(),
        ];
    }

    /**
     * B18 (Phase 6, P6-17): may a certificate be issued for this host? `verified` / `ssl_provisioning` / `active`
     * custom rows and `active` platform rows of a store that is not suspended.
     */
    public function domainAllowed(string $host): bool
    {
        if ($this->rls->enabled()) {
            return (bool) DB::selectOne('select sp_domain_allowed(?) as allowed', [$host])?->allowed;
        }

        $domain = StoreDomain::withoutTenancy()->where('hostname', $host)
            ->where(fn ($q) => $q->where('status', StoreDomain::STATUS_ACTIVE)->orWhere(fn ($c) => $c->where('type', StoreDomain::TYPE_CUSTOM)
                ->whereIn('status', [StoreDomain::STATUS_VERIFIED, StoreDomain::STATUS_SSL_PROVISIONING])))
            ->first(['tenant_id', 'store_id']);

        return $domain !== null && Store::withoutTenancy()->whereKey($domain->store_id)->where('tenant_id', $domain->tenant_id)
            ->where('status', '!=', Store::STATUS_SUSPENDED)->exists();
    }

    /** B5 / P5B-8: store slugs are unique across all tenants. */
    public function storeSlugTaken(string $slug): bool
    {
        if ($this->rls->enabled()) {
            return (bool) DB::selectOne('select sp_store_slug_taken(?) as taken', [$slug])?->taken;
        }

        return Store::withoutTenancy()->where('slug', $slug)->exists();
    }
}
