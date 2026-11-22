<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Drivers\WebhookEventData;
use App\Domain\Couriers\Jobs\ProcessCourierWebhook;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Webhooks\WebhookIngestor;

/**
 * Stores an authenticated, parsed courier event once (WebhookIngestor, U(tenant_id, provider, event_id)) next to the
 * parsed report, and queues ProcessCourierWebhook on `webhooks` — or runs it inline (`$inline`, the fake-advance
 * tool). Shared by the webhook endpoint and the testing tools so both take exactly the same path.
 */
final class CourierWebhooks
{
    public function __construct(private readonly WebhookIngestor $ingestor) {}

    /**
     * @param  array{tenant_id: string, store_id: string, account_id: string}  $owner
     * @param  array<array-key, mixed>  $payload  the request body (scrubbed here)
     * @return WebhookEvent|null null for a duplicate event id
     */
    public function store(array $owner, string $provider, WebhookEventData $data, array $payload, bool $inline = false): ?WebhookEvent
    {
        $stored = CourierPayload::scrub($data->payload !== [] ? $data->payload : $payload);
        if ($data->update !== null) {
            $stored[ProcessCourierWebhook::PARSED] = ProcessCourierWebhook::parsed($data->consignmentId, $data->invoice, $data->update);
        }
        $status = $data->update !== null ? WebhookEvent::RECEIVED : WebhookEvent::IGNORED;
        $event = $this->ingestor->ingest($owner, $provider, $data->eventId, $data->eventType, $stored, $status,
            $inline ? null : fn (WebhookEvent $e) => new ProcessCourierWebhook($e->id));
        if ($inline && $event !== null && $status === WebhookEvent::RECEIVED) {
            dispatch_sync((new ProcessCourierWebhook($event->id))->forTenant($owner['tenant_id']));
        }

        return $event;
    }
}
