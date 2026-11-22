<?php

namespace App\Domain\Stores\Services;

use App\Domain\Tenancy\Support\PreTenantLookup;
use Illuminate\Contracts\Cache\Factory as CacheFactory;

/**
 * Central hostname -> (tenant, store) resolution for the public storefront.
 *
 * Only ACTIVE domains of non-suspended stores resolve. Lookups are cached under the
 * tenant-neutral key "domain:{host}" (positive and short negative caching); the
 * StoreDomainObserver / StoreObserver invalidate entries whenever domains or store status change.
 */
class StorefrontResolver
{
    private const MISS = '__none__';

    public function __construct(
        private readonly CacheFactory $cache,
        private readonly PreTenantLookup $preTenant,
    ) {}

    public static function cacheKey(string $hostname): string
    {
        return 'domain:'.$hostname;
    }

    public function resolve(?string $rawHost): ?ResolvedStorefront
    {
        $host = HostNormalizer::normalize($rawHost);

        if ($host === null) {
            return null;
        }

        $store = $this->cache->store();
        $key = self::cacheKey($host);
        $cached = $store->get($key);

        if ($cached === self::MISS) {
            return null;
        }

        if (is_array($cached)) {
            return new ResolvedStorefront($host, $cached['tenant_id'], $cached['store_id']);
        }

        $resolved = $this->lookup($host);

        if ($resolved === null) {
            $store->put($key, self::MISS, (int) config('storeplix.domain_negative_cache_ttl', 60));

            return null;
        }

        $store->put($key, ['tenant_id' => $resolved->tenantId, 'store_id' => $resolved->storeId], (int) config('storeplix.domain_cache_ttl', 3600));

        return $resolved;
    }

    public function forget(string $hostname): void
    {
        $host = HostNormalizer::normalize($hostname);

        if ($host !== null) {
            $this->cache->store()->forget(self::cacheKey($host));
        }
    }

    private function lookup(string $host): ?ResolvedStorefront
    {
        // Pre-tenant path B1: sp_resolve_host() with RLS on, an explicit scope opt-out otherwise (ids only).
        $ids = $this->preTenant->resolveHost($host);

        return $ids === null ? null : new ResolvedStorefront($host, $ids['tenant_id'], $ids['store_id']);
    }
}
