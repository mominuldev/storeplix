<?php

namespace App\Domain\Stores\Services;

final readonly class ResolvedStorefront
{
    public function __construct(
        public string $hostname,
        public string $tenantId,
        public string $storeId,
        /** PHASE-8-1 §4.1: the store is suspended → only `GET /storefront/config` answers (StorefrontSuspended). */
        public bool $suspended = false,
    ) {}
}
