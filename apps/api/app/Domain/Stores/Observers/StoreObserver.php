<?php

namespace App\Domain\Stores\Observers;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\TenantContext;

/** Store status affects storefront resolution, so flush its domains from the host cache. */
class StoreObserver
{
    public function __construct(
        private readonly StorefrontResolver $resolver,
        private readonly TenantContext $context,
    ) {}

    public function updated(Store $store): void
    {
        if ($store->wasChanged('status')) {
            $this->flush($store);
        }
    }

    public function deleting(Store $store): void
    {
        $this->flush($store);
    }

    private function flush(Store $store): void
    {
        // B6 (Phase 5b): a plain scoped query inside the store's own tenant (usually already the current one).
        $this->context->run($store->tenant_id, fn () => StoreDomain::query()
            ->where('store_id', $store->getKey())
            ->pluck('hostname')
            ->each(fn (string $host) => $this->resolver->forget($host)));
    }
}
