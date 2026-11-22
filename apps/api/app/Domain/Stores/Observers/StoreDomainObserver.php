<?php

namespace App\Domain\Stores\Observers;

use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\StorefrontResolver;

/**
 * Invalidates the tenant-neutral "domain:{host}" cache whenever a domain changes. Phase 6 (P6-16): only creates,
 * deletes and saves that change status, is_primary or hostname; check bookkeeping saves are ignored.
 */
class StoreDomainObserver
{
    public function __construct(private readonly StorefrontResolver $resolver) {}

    public function saved(StoreDomain $domain): void
    {
        if (! $domain->wasRecentlyCreated && ! $domain->wasChanged(StoreDomain::ROUTING_FIELDS)) {
            return;
        }
        $this->resolver->forget($domain->hostname);

        $original = $domain->getOriginal('hostname');
        if (is_string($original) && $original !== $domain->hostname) {
            $this->resolver->forget($original);
        }
    }

    public function deleted(StoreDomain $domain): void
    {
        $this->resolver->forget($domain->hostname);
    }
}
