<?php

namespace App\Domain\Stores\Observers;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StorefrontResolver;

/** Store status affects storefront resolution, so flush its domains from the host cache. */
class StoreObserver
{
    public function __construct(private readonly StorefrontResolver $resolver) {}

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
        StoreDomain::withoutTenancy()
            ->where('store_id', $store->getKey())
            ->pluck('hostname')
            ->each(fn (string $host) => $this->resolver->forget($host));
    }
}
