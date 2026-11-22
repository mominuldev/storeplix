<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/**
 * A parsed courier webhook (P5B-37). `eventId` is the dedupe key for webhook_events U(tenant_id, provider, event_id).
 * Look the shipment up by `consignmentId` first, else by `invoice` (= our shipment id), and ALWAYS within the tenant
 * resolved from the route key (S32). `update` is null for events that carry no parcel status (ack and store only).
 */
final readonly class WebhookEventData
{
    /** @param array<array-key, mixed> $payload scrubbed, for webhook_events.payload */
    public function __construct(
        public string $eventId,
        public ?string $consignmentId,
        public ?string $invoice,
        public ?string $eventType,
        public ?StatusUpdate $update,
        public array $payload = [],
    ) {}
}
