<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

/**
 * What the provider reports about a charge. `status`: succeeded (provider final success: bKash `Completed`,
 * SSLCommerz `VALID`/`VALIDATED`) | failed | cancelled | pending. `amount` is paisa via Money::fromDecimal, or null when
 * the provider amount is missing or has more than 2 decimals (treat as a mismatch). `reference` is our payment id as
 * echoed by the provider (bKash merchantInvoiceNumber, SSLCommerz tran_id). `raw` is scrubbed.
 */
final readonly class Verification
{
    public const SUCCEEDED = 'succeeded';

    public const FAILED = 'failed';

    public const CANCELLED = 'cancelled';

    public const PENDING = 'pending';

    /** @param array<string, mixed> $raw */
    public function __construct(
        public string $status,
        public ?int $amount,
        public ?string $currency,
        public ?string $reference,
        public ?string $providerTrxId,
        public ?string $failureCode,
        public array $raw = [],
    ) {}

    public function succeeded(): bool
    {
        return $this->status === self::SUCCEEDED;
    }
}
