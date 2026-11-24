<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Automations\Jobs\EvaluateAutomation;
use App\Domain\Automations\Jobs\HandleOrderPlaced;
use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Trigger fan-out (PHASE-8-6 P86-3, §4.1). `handle()` is called from WebhookEvents::emit's after-commit closure, inside
 * the tenant, before (and independent of) the webhook endpoint/plan filter. It loads the store's `on` automations whose
 * recipe listens to the trigger and, when the plan has `sms_automation`, dispatches one EvaluateAutomation each (queue
 * `automations`). `order.created` feeds the recovery exit / attribution hook. Never throws into the caller.
 */
final class AutomationTriggers
{
    public static function handle(WebhookEventType $type, string $storeId, string $subjectType, string $subjectId, mixed $at = null): void
    {
        try {
            if ($type === WebhookEventType::OrderCreated) {
                if (Automation::query()->where('store_id', $storeId)->where('recipe', 'checkout_recovery')->exists()) {
                    dispatch(new HandleOrderPlaced($subjectId));
                }

                return;
            }
            [$trigger, $type2, $id] = match ($type) {
                WebhookEventType::ShipmentDelivered => ['order.delivered', 'order', Shipment::query()->whereKey($subjectId)->value('order_id')],
                WebhookEventType::ReturnReceived => ['return.received', 'return', $subjectId],
                WebhookEventType::StockLow => ['stock.low', 'inventory', $subjectId],
                default => [null, null, null],
            };
            if ($trigger === null || ! is_string($id)) {
                return;
            }
            self::fire($storeId, $trigger, $type2, $id);
        } catch (Throwable $e) {
            report($e);
        }
    }

    /**
     * Unfinished online order (P86-13, Q165): one line in OrderService::systemCancel; after commit, a `payment_timeout`
     * cancel of an order with a phone feeds `checkout.abandoned` (same dedupe space as carts).
     */
    public static function unfinishedOrder(Order $order, string $reason): void
    {
        try {
            $context = app(TenantContext::class);
            if ($reason !== 'payment_timeout' || ! $context->has() || trim((string) $order->customer_phone) === '') {
                return;
            }
            $tenantId = (string) $context->id();
            $storeId = $order->store_id;
            $orderId = $order->id;
            DB::afterCommit(function () use ($context, $tenantId, $storeId, $orderId) {
                try {
                    $work = fn () => self::fire($storeId, 'checkout.abandoned', 'order', $orderId);
                    $context->id() === $tenantId ? $work() : $context->run($tenantId, $work);
                } catch (Throwable $e) {
                    report($e);
                }
            });
        } catch (Throwable $e) {
            report($e);
        }
    }

    /** Dispatches EvaluateAutomation for each `on` automation of the store listening to `$trigger`. Returns the count. */
    public static function fire(string $storeId, string $trigger, string $subjectType, string $subjectId): int
    {
        $automations = Automation::query()->where('store_id', $storeId)->where('status', Automation::ON)
            ->whereIn('recipe', RecipeCatalogue::forTrigger($trigger))->pluck('id');
        if ($automations->isEmpty() || ! self::planAllows()) {
            return 0; // P86-17: not in plan → no run
        }
        foreach ($automations as $id) {
            dispatch(new EvaluateAutomation((string) $id, $trigger, $subjectType, $subjectId));
        }

        return $automations->count();
    }

    public static function planAllows(): bool
    {
        $tenant = app(TenantContext::class)->tenant();

        return $tenant !== null && FeatureGate::allows($tenant, Feature::SmsAutomation);
    }
}
