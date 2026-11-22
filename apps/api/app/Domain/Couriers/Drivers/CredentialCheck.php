<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/** Result of a live credential check (P5B-31). `balanceAmount` in paisa when the courier reports one (Steadfast). */
final readonly class CredentialCheck
{
    public function __construct(
        public bool $ok,
        public ?int $balanceAmount = null,
    ) {}
}
