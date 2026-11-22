<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/**
 * A raw courier status translated by a driver's status map (P5B-36, §6). `status` is one of Shipment::COURIER_STATUSES
 * or null = "leave the shipment status unchanged" (unknown words, Pathao `paid`/`exchanged`, pickup-failed). `problem`
 * is one of Shipment::PROBLEMS (null clears it); `settled` = the courier reports the COD paid out (Pathao `paid`).
 */
final readonly class NormalisedStatus
{
    public function __construct(
        public ?string $status,
        public ?string $problem = null,
        public bool $settled = false,
    ) {}

    public static function unknown(): self
    {
        return new self(null, 'unknown');
    }

    /** Map entry shorthand: a status (problem derived for delivery_failed/on_hold/returning). */
    public static function of(string $status): self
    {
        return new self($status, in_array($status, ['delivery_failed', 'on_hold', 'returning'], true) ? $status : null);
    }

    /** @return array{status: ?string, problem: ?string, settled: bool} */
    public function toArray(): array
    {
        return ['status' => $this->status, 'problem' => $this->problem, 'settled' => $this->settled];
    }
}
