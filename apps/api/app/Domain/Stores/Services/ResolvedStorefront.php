<?php

namespace App\Domain\Stores\Services;

final readonly class ResolvedStorefront
{
    public function __construct(
        public string $hostname,
        public string $tenantId,
        public string $storeId,
    ) {}
}
