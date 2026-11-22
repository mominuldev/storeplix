<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use Carbon\CarbonImmutable;

/**
 * One courier status report (poll, webhook or re-query). `status`/`problem`/`settled` come from the driver's status
 * map (null status = unchanged, see NormalisedStatus); `providerStatus` is the courier's raw word (stored as
 * shipments.provider_status / shipment_events.provider_status); `codCollectedAmount` in paisa when reported.
 */
final readonly class StatusUpdate
{
    /** @param array<array-key, mixed> $raw scrubbed */
    public function __construct(
        public ?string $status,
        public string $providerStatus,
        public CarbonImmutable $occurredAt,
        public ?string $description = null,
        public ?string $location = null,
        public ?int $codCollectedAmount = null,
        public ?string $problem = null,
        public bool $settled = false,
        public array $raw = [],
    ) {}

    /** @param array<array-key, mixed> $raw */
    public static function from(NormalisedStatus $n, string $providerStatus, CarbonImmutable $occurredAt, ?string $description = null, ?string $location = null, ?int $codCollectedAmount = null, array $raw = []): self
    {
        return new self($n->status, $providerStatus, $occurredAt, $description, $location, $codCollectedAmount, $n->problem, $n->settled, $raw);
    }

    /** Statuses whose order effect moves money: re-query the courier before applying them from a webhook (P5B-37). */
    public function isMoneyRelevant(): bool
    {
        return in_array($this->status, ['delivered', 'partially_delivered', 'returned', 'cancelled'], true);
    }
}
