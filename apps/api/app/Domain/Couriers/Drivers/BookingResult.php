<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/** A parcel the courier accepted (or found again by invoice). Amounts in paisa; `raw` is scrubbed (CourierPayload). */
final readonly class BookingResult
{
    /** @param array<array-key, mixed> $raw */
    public function __construct(
        public string $consignmentId,
        public string $trackingCode,
        public ?string $trackingUrl = null,
        public ?int $deliveryFeeAmount = null,
        public ?int $codChargeAmount = null,
        public ?string $providerStatus = null,
        public array $raw = [],
    ) {}
}
