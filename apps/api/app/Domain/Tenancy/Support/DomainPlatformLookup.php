<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

use App\Domain\Stores\Models\StoreDomain;

/**
 * Phase 6 platform-side domain lookups outside any tenant (PHASE-6-CONTRACT §3.4 B19): ids and flags only, on the
 * platform connection (`pgsql_admin` with RLS on). Used by DeleteProviderHostnameJob and the domain commands.
 */
class DomainPlatformLookup
{
    /** Does any store_domains row (any tenant) still reference this provider hostname? */
    public function providerHostnameReferenced(string $providerHostnameId, ?string $exceptDomainId = null): bool
    {
        // cross-tenant: provider cleanup must not delete a hostname another row adopted.
        return StoreDomain::withoutTenancy()->where('provider_hostname_id', $providerHostnameId)
            ->when($exceptDomainId !== null, fn ($q) => $q->whereKeyNot($exceptDomainId))->exists();
    }

    /**
     * @param  list<string>  $providerHostnameIds
     * @return list<string> the ids some row references
     */
    public function referencedProviderIds(array $providerHostnameIds): array
    {
        if ($providerHostnameIds === []) {
            return [];
        }

        // cross-tenant: orphan reconcile (domains:reconcile-provider).
        return StoreDomain::withoutTenancy()->whereIn('provider_hostname_id', $providerHostnameIds)->pluck('provider_hostname_id')->all();
    }
}
