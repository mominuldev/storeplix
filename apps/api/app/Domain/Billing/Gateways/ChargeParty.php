<?php

declare(strict_types=1);

namespace App\Domain\Billing\Gateways;

/** P7-11: the only payer data sent to the provider (owner name/email/phone, city, plan line, invoice number). */
final readonly class ChargeParty
{
    public function __construct(
        public string $name,
        public ?string $email,
        public ?string $phone,
        public string $city,
        public string $productName,
        public string $invoiceNumber,
    ) {}
}
