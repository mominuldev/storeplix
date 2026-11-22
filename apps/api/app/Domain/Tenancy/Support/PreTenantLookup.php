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

    /** B5 / P5B-8: store slugs are unique across all tenants. */
    public function storeSlugTaken(string $slug): bool
    {
        if ($this->rls->enabled()) {
            return (bool) DB::selectOne('select sp_store_slug_taken(?) as taken', [$slug])?->taken;
        }

        return Store::withoutTenancy()->where('slug', $slug)->exists();
    }
}
