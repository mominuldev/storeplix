<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

/** Provider answer to a refund request or a refund status query. `raw` is scrubbed. */
final readonly class RefundResult
{
    public const SUCCEEDED = 'succeeded';

    public const PROCESSING = 'processing';

    public const FAILED = 'failed';

    /** @param array<string, mixed> $raw */
    public function __construct(
        public string $status,
        public ?string $providerRefundId,
        public ?string $failureCode,
        public array $raw = [],
    ) {}
}
