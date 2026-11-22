<?php

declare(strict_types=1);

namespace App\Domain\Domains;

final readonly class NormalizedHostname
{
    public function __construct(
        public string $hostname,
        public string $display,
        public string $registrable,
    ) {}

    public function isApex(): bool
    {
        return $this->hostname === $this->registrable;
    }
}
