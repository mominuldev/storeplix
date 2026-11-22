<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;

/**
 * A courier driver (PHASE-5B P5B-30–P5B-43, §6, ADR 0013). Drivers only REPORT what the courier says; the effects
 * (shipment/order updates, events, money) belong to BookingService / ShipmentSync. Every call goes through
 * SafeHttpClient with the base URL from config/couriers.php by provider and the account's mode. Every undocumented
 * detail is marked `VERIFY against sandbox` and isolated in one method.
 *
 * Errors: CourierException (see its doc for codes and HTTP statuses).
 */
interface CourierDriver
{
    /** Live credential check (Steadfast GET /get_balance; Pathao issue-token; RedX GET /areas). */
    public function checkCredentials(CourierAccount $account): CredentialCheck;

    /** Book one parcel. provider_unavailable = outcome unknown (keep `booking`, reconcile with findByInvoice). */
    public function book(Shipment $shipment, CourierAccount $account, BookingRequest $request): BookingResult;

    /**
     * Book many parcels. Returns one BookingResult|CourierException per input, with the input's keys.
     * Steadfast: bulk endpoint, 500 per request; Pathao/RedX: one by one.
     *
     * @param  array<array-key, BookingRequest>  $requests
     * @return array<array-key, BookingResult|CourierException>
     */
    public function bookBulk(CourierAccount $account, array $requests): array;

    /** Current status from the courier's status API (polls and webhook re-queries). */
    public function status(Shipment $shipment, CourierAccount $account): StatusUpdate;

    /** Find a parcel by our invoice (= shipment id) after a timed-out booking; null when the courier has none. */
    public function findByInvoice(string $invoice, CourierAccount $account): ?BookingResult;

    /** Cancel a booked parcel. Throws CourierException('courier_cancel_unsupported') when the courier has no API. */
    public function cancel(Shipment $shipment, CourierAccount $account): void;

    /**
     * Authenticate and parse a webhook. Throws CourierException('webhook_unauthorized') on a missing/wrong secret.
     * Returns null for events that need only an acknowledgement (Pathao `webhook_integration`).
     *
     * @param  array<string, mixed>  $payload
     * @param  array<string, string|array<int, string>>  $headers  request headers (any case)
     */
    public function parseWebhook(array $payload, array $headers, CourierAccount $account): ?WebhookEventData;

    public function supportsWebhooks(): bool;

    /**
     * Courier areas for the booking dialog (P5B-39). $level ∈ city|zone|area; $parentId = city id for zones, zone id
     * for areas. Steadfast: [] (free-text address).
     *
     * @return list<CourierArea>
     */
    public function areas(CourierAccount $account, string $level, ?string $parentId): array;

    /** @return list<PickupStore> courier-side pickup stores (Steadfast: []) */
    public function pickupStores(CourierAccount $account): array;

    /** @return list<'bulk'|'cancel'|'areas'|'quote'|'webhook'> for CourierAccount.capabilities */
    public function capabilities(): array;

    /**
     * Data-driven raw status → normalised status map (§6; §13 "mapping table per provider").
     *
     * @return array<string, NormalisedStatus>
     */
    public static function statusMap(): array;

    /**
     * Translate one raw courier status. Unknown words → NormalisedStatus::unknown(). $shipment gives the context some
     * couriers need (Steadfast `pending` after `in_review` = picked up; `cancelled` after pickup = returning).
     */
    public function normalise(string $rawStatus, ?Shipment $shipment = null): NormalisedStatus;
}
