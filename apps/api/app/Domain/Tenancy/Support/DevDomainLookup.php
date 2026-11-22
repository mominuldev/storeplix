<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

use App\Domain\Stores\Models\StoreDomain;

/**
 * TESTING-ONLY pre-tenant lookup for `POST /dev/domains/{domain}/*` (PHASE-6 §3.4 B21; DOMAINS_FAKE, never in
 * production): domain id → owning tenant/store. The caller then works inside TenantContext::run().
 */
class DevDomainLookup
{
    /** @return array{tenant_id: string, store_id: string}|null */
    public function domainOwner(string $domainId): ?array
    {
        if (app()->environment('production') || ! config('domains.fake')) {
            return null;
        }
        $id = strtolower($domainId);
        if (preg_match('/^[0-9a-hjkmnp-tv-z]{26}$/', $id) !== 1) {
            return null;
        }
        // cross-tenant: dev-only lookup of a domain's owner (fake drivers; route not registered in production).
        $row = StoreDomain::withoutTenancy()->whereKey($id)->first(['tenant_id', 'store_id']);

        return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id];
    }
}
