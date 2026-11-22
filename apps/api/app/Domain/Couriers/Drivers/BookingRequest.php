<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/**
 * What BookingService sends to a driver (P5B-33/34/35). `invoice` = the shipment id (unique per attempt, so a
 * timed-out booking can be found again). Money in paisa; drivers convert to the courier's taka format.
 * `cityId/zoneId/areaId` come from courier_area_mappings or the booking dialog (Pathao city/zone/area, RedX area in
 * `areaId` with its name in `areaName`). `providerStoreId` = Pathao `store_id` / RedX `pickup_store_id`.
 */
final readonly class BookingRequest
{
    public function __construct(
        public string $invoice,
        public string $recipientName,
        public string $recipientPhone,
        public string $recipientAddress,
        public string $district,
        public string $thana,
        public int $codAmount,
        public int $weightGrams,
        public string $itemDescription,
        public ?string $note = null,
        public ?string $orderNumber = null,
        public ?string $cityId = null,
        public ?string $zoneId = null,
        public ?string $areaId = null,
        public ?string $areaName = null,
        public int $deliveryType = 48,
        public int $itemType = 2,
        public int $itemQuantity = 1,
        public ?string $providerStoreId = null,
        public ?string $storeId = null,
        public ?string $pickupLocationId = null,
        public ?int $declaredValueAmount = null,
        public ?string $recipientEmail = null,
    ) {}

    /** Recipient address line as sent to couriers that take free text (address, thana, district; ≤ 250). */
    public function fullAddress(int $max = 250): string
    {
        $parts = array_values(array_filter([trim($this->recipientAddress), trim($this->thana), trim($this->district)], fn ($p) => $p !== ''));

        return mb_substr(implode(', ', $parts), 0, $max);
    }
}
