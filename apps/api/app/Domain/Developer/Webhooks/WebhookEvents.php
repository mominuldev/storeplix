<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\Webhooks\Models\WebhookEndpoint;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * PHASE-8-4 §4.1 emission. Domain code calls one line at each emit point; the work runs after the surrounding
 * transaction commits (dropped on rollback). Records nothing when the store has no active endpoint subscribed to the
 * event, or the plan lacks `api_webhooks` (P84-13: dropped, not queued). The payload is a snapshot built after commit
 * (P84-12). Never throws into the caller: a failure here is reported and the domain action stands.
 */
final class WebhookEvents
{
    public static function emit(WebhookEventType $type, Model $subject): void
    {
        try {
            $context = app(TenantContext::class);
            $storeId = $subject->getAttribute('store_id');
            $subjectType = $type->subjectType();
            if (! $context->has() || ! is_string($storeId) || $subjectType === null) {
                return;
            }
            $tenantId = (string) $context->id();
            $subjectId = (string) $subject->getKey();
            $at = now();
            DB::afterCommit(function () use ($context, $tenantId, $type, $storeId, $subjectType, $subjectId, $at) {
                $work = fn () => self::record($type, $storeId, $subjectType, $subjectId, $at);
                try {
                    $context->id() === $tenantId ? $work() : $context->run($tenantId, $work);
                } catch (Throwable $e) {
                    Log::warning('webhooks.emit_failed', ['event' => $type->value, 'subject_id' => $subjectId, 'error' => $e::class]);
                    report($e);
                }
            });
        } catch (Throwable $e) {
            report($e);
        }
    }

    public static function emitWhen(bool $condition, WebhookEventType $type, Model $subject): void
    {
        if ($condition) {
            self::emit($type, $subject);
        }
    }

    /** order.confirmed / order.cancelled for a status transition (other targets emit nothing). */
    public static function orderStatus(Order $order, string $to): void
    {
        match ($to) {
            Order::CONFIRMED => self::emit(WebhookEventType::OrderConfirmed, $order),
            Order::CANCELLED => self::emit(WebhookEventType::OrderCancelled, $order),
            default => null,
        };
    }

    /** order.paid when payment_status was just set (not yet saved) to `paid` from something else. */
    public static function orderPaidIfChanged(Order $order): void
    {
        self::emitWhen($order->payment_status === 'paid' && $order->isDirty('payment_status'), WebhookEventType::OrderPaid, $order);
    }

    /** shipment.updated, plus shipment.delivered when the (new) status is `delivered`. */
    public static function shipment(Shipment $shipment, ?string $to = null): void
    {
        self::emit(WebhookEventType::ShipmentUpdated, $shipment);
        self::emitWhen(($to ?? $shipment->status) === 'delivered', WebhookEventType::ShipmentDelivered, $shipment);
    }

    /** stock.low once per crossing: on_hand went from above the threshold to at or below it. */
    public static function stock(Inventory $row, int $old, int $new): void
    {
        $threshold = $row->effectiveThreshold();
        self::emitWhen($old > $threshold && $new <= $threshold, WebhookEventType::StockLow, $row);
    }

    private static function record(WebhookEventType $type, string $storeId, string $subjectType, string $subjectId, mixed $at): void
    {
        $endpoints = WebhookEndpoint::query()->where('store_id', $storeId)->where('is_active', true)->orderBy('created_at')->get()
            ->filter(fn (WebhookEndpoint $e) => $e->subscribes($type->value));
        if ($endpoints->isEmpty()) {
            return;
        }
        $tenant = app(TenantContext::class)->tenant();
        if ($tenant === null || ! FeatureGate::allows($tenant, Feature::ApiWebhooks)) {
            return;
        }
        $subject = app(WebhookPayloads::class)->subject($subjectType, $subjectId);
        if ($subject === null) {
            return;
        }
        $eventId = WebhookDeliveries::newId();
        $payload = WebhookPayloads::envelope($eventId, $type, $storeId, $subject['object'], $at);
        $deliveries = app(WebhookDeliveries::class);
        foreach ($endpoints as $endpoint) {
            $deliveries->create($endpoint, $eventId, $type->value, $payload, $subjectType, $subjectId, $subject['label']);
        }
    }
}
