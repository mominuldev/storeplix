<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Jobs;

use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Drivers\StatusUpdate;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Webhooks\WebhookIngestor;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Processes one stored courier event on the `webhooks` queue (P5B-37, S32). The shipment is looked up by consignment
 * (else by our invoice = shipment id) WITHIN the event's tenant, store, provider and account — a consignment of
 * another store is simply not found. Money-relevant statuses are re-queried from the courier (ShipmentSync).
 */
class ProcessCourierWebhook implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [30, 120];

    public function __construct(public readonly string $eventId) {}

    /** The parsed report kept next to the scrubbed payload (no PII: ids, status words, amounts). */
    public const PARSED = '_parsed';

    public function handle(ShipmentSync $sync): void
    {
        $event = WebhookEvent::query()->find($this->eventId);
        if ($event === null || $event->status !== WebhookEvent::RECEIVED) {
            return;
        }
        $parsed = ((array) $event->payload)[self::PARSED] ?? null;
        if (! is_array($parsed) || ! is_string($parsed['provider_status'] ?? null)) {
            WebhookIngestor::finish($event, WebhookEvent::IGNORED, 'no_status');

            return;
        }
        $shipment = self::shipment($event->store_id, $event->provider, $event->account_id, $parsed['consignment_id'] ?? null, $parsed['invoice'] ?? null);
        if ($shipment === null) {
            WebhookIngestor::finish($event, WebhookEvent::IGNORED, 'unknown_shipment');

            return;
        }

        try {
            $sync->applyWebhook($shipment, self::update($parsed));
            WebhookIngestor::finish($event, WebhookEvent::PROCESSED);
        } catch (CourierException $e) {
            Log::warning('couriers.webhook_unverified', ['event_id' => $event->id, 'shipment_id' => $shipment->id, 'code' => $e->errorCode]);
            if ($this->attempts() < $this->tries && $this->job !== null && $this->job->getConnectionName() !== 'sync') {
                throw $e;
            }
            WebhookIngestor::finish($event, WebhookEvent::FAILED, $e->errorCode);
        } catch (Throwable $e) {
            report($e);
            WebhookIngestor::finish($event, WebhookEvent::FAILED, 'error');
        }
    }

    public static function shipment(string $storeId, string $provider, ?string $accountId, mixed $consignment, mixed $invoice): ?Shipment
    {
        $query = fn () => Shipment::query()->where('store_id', $storeId)->where('provider', $provider)
            ->when($accountId !== null && $accountId !== '', fn ($q) => $q->where('courier_account_id', $accountId));
        if (is_string($consignment) && $consignment !== '') {
            $found = $query()->where('consignment_id', mb_substr($consignment, 0, 64))->first();
            if ($found !== null) {
                return $found;
            }
        }
        if (is_string($invoice) && preg_match('/^[0-9A-Za-z]{26}$/', $invoice) === 1) {
            return $query()->whereKey(strtolower($invoice))->first();
        }

        return null;
    }

    /** @param array<string, mixed> $p */
    public static function update(array $p): StatusUpdate
    {
        return new StatusUpdate(
            status: is_string($p['status'] ?? null) ? $p['status'] : null,
            providerStatus: (string) $p['provider_status'],
            occurredAt: is_string($p['occurred_at'] ?? null) ? CarbonImmutable::parse($p['occurred_at']) : CarbonImmutable::now(),
            description: is_string($p['description'] ?? null) ? $p['description'] : null,
            location: is_string($p['location'] ?? null) ? $p['location'] : null,
            codCollectedAmount: is_int($p['cod_collected_amount'] ?? null) ? $p['cod_collected_amount'] : null,
            problem: is_string($p['problem'] ?? null) ? $p['problem'] : null,
            settled: (bool) ($p['settled'] ?? false),
        );
    }

    /** @return array<string, mixed> */
    public static function parsed(?string $consignment, ?string $invoice, StatusUpdate $u): array
    {
        return [
            'consignment_id' => $consignment,
            'invoice' => $invoice,
            'status' => $u->status,
            'provider_status' => $u->providerStatus,
            'occurred_at' => $u->occurredAt->toIso8601ZuluString('microsecond'),
            'description' => $u->description,
            'location' => $u->location,
            'cod_collected_amount' => $u->codCollectedAmount,
            'problem' => $u->problem,
            'settled' => $u->settled,
        ];
    }

    public function attempts(): int
    {
        return $this->job?->attempts() ?? 1;
    }
}
