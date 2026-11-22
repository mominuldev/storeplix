<?php

declare(strict_types=1);

namespace App\Domain\Domains\Events;

/** P6-10: fired after every committed domain transition (emails, P6-19). Ids and values only. */
final readonly class DomainStatusChanged
{
    public function __construct(
        public string $tenantId,
        public string $storeId,
        public string $domainId,
        public string $hostname,
        public string $from,
        public string $to,
        public ?string $failureCode = null,
    ) {}
}
