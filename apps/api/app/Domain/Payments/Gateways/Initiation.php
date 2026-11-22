<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

/** Result of PaymentGateway::initiate: where to send the shopper. `raw` is scrubbed (PayloadScrubber). */
final readonly class Initiation
{
    /** @param array<string, mixed> $raw */
    public function __construct(
        public string $redirectUrl,
        public ?string $providerPaymentId,
        public array $raw = [],
    ) {}
}
