<?php

declare(strict_types=1);

namespace App\Domain\Webhooks;

use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Store-then-queue for every inbound provider event (P5B-19, P5B-37, S24). Gateways (5b-2) and couriers (5b-3) share
 * it. The caller resolves the account from the route key (IntegrationLookup) and authenticates the request; this
 * class, inside that account's tenant:
 *  1. inserts the (already scrubbed) event once per U(tenant_id, provider, event_id) — `ON CONFLICT DO NOTHING`, so a
 *     replay is a no-op that doesn't abort the surrounding transaction;
 *  2. dispatches the processing job (tenant-aware, `webhooks` queue) only for a newly stored event.
 * The HTTP response never waits for processing and never carries tenant data.
 */
class WebhookIngestor
{
    public const QUEUE = 'webhooks';

    public function __construct(private readonly TenantContext $context) {}

    /**
     * @param  array{tenant_id: string, store_id: string, account_id: string}  $owner
     * @param  array<string, mixed>  $payload  scrubbed
     * @param  (callable(WebhookEvent): object)|null  $job  builds the processing job for a new event
     * @return WebhookEvent|null the stored event; null for a duplicate
     */
    public function ingest(array $owner, string $provider, string $eventId, ?string $eventType, array $payload, string $status = WebhookEvent::RECEIVED, ?callable $job = null): ?WebhookEvent
    {
        return $this->context->run($owner['tenant_id'], function () use ($owner, $provider, $eventId, $eventType, $payload, $status, $job) {
            $id = strtolower((string) Str::ulid());
            $now = now();
            $inserted = DB::table('webhook_events')->insertOrIgnore([
                'id' => $id,
                'tenant_id' => $owner['tenant_id'],
                'store_id' => $owner['store_id'],
                'provider' => $provider,
                'account_id' => $owner['account_id'],
                'event_id' => mb_substr($eventId, 0, 128),
                'event_type' => $eventType !== null ? mb_substr($eventType, 0, 64) : null,
                'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR),
                'status' => $status,
                'attempts' => 0,
                'received_at' => $now,
                'processed_at' => $status === WebhookEvent::RECEIVED ? null : $now,
            ]);
            if ($inserted !== 1) {
                return null;
            }
            /** @var WebhookEvent $event */
            $event = WebhookEvent::query()->findOrFail($id);
            if ($job !== null && $status === WebhookEvent::RECEIVED) {
                $instance = $job($event);
                if (method_exists($instance, 'forTenant')) {
                    $instance->forTenant($owner['tenant_id']);
                }
                if (method_exists($instance, 'onQueue')) {
                    $instance->onQueue(self::QUEUE);
                }
                dispatch($instance);
            }

            return $event;
        });
    }

    /** Marks the outcome of processing (the job's last step). */
    public static function finish(WebhookEvent $event, string $status, ?string $errorCode = null): void
    {
        WebhookEvent::query()->whereKey($event->id)->update([
            'status' => $status,
            'error_code' => $errorCode !== null ? mb_substr($errorCode, 0, 48) : null,
            'attempts' => DB::raw('attempts + 1'),
            'processed_at' => now(),
        ]);
    }
}
