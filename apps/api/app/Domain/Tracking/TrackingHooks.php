<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * PHASE-8-9D §5.3 / §5.4: one-line hooks called by Orders / Payments / Couriers where the order status and refunds
 * change. The work runs after the surrounding transaction commits (dropped on rollback), inside the order's tenant, and
 * never throws into the caller. A store with no tracking integration costs one indexed lookup (P89D-2).
 */
final class TrackingHooks
{
    /**
     * The order was placed (OrderCreated) or moved to $to. Triggers are cumulative — a confirmed order has been placed, a
     * delivered one confirmed — and the event id `purchase.{order}` keeps it to one send per destination, so an order
     * that skips a step (online payment straight to confirmed) still reaches every trigger once.
     */
    public static function orderStatus(Order $order, string $to): void
    {
        $triggers = match ($to) {
            Order::PENDING => ['order_placed'],
            Order::CONFIRMED, Order::READY_TO_SHIP, Order::SHIPPED => ['order_placed', 'order_confirmed'],
            Order::DELIVERED => ['order_placed', 'order_confirmed', 'order_delivered'],
            default => [], // pending_payment counts once it leaves that state (P5B-14); cancelled / returned send nothing
        };
        if ($triggers === [] || $order->created_via === Order::VIA_POS) {
            return;
        }
        $orderId = $order->id;
        self::later(fn () => ($o = Order::query()->find($orderId)) !== null ? TrackingRecorder::purchase($o, $triggers) : null);
    }

    /** A refund payment reached `succeeded` (gateway or manual). */
    public static function refund(string $orderId, string $paymentId, int $amount): void
    {
        self::later(fn () => ($o = Order::query()->find($orderId)) !== null ? TrackingRecorder::refund($o, $paymentId, $amount) : null);
    }

    private static function later(callable $work): void
    {
        try {
            $context = app(TenantContext::class);
            if (! $context->has()) {
                return;
            }
            $tenantId = (string) $context->id();
            DB::afterCommit(function () use ($context, $tenantId, $work) {
                try {
                    $context->id() === $tenantId ? $work() : $context->run($tenantId, $work);
                } catch (Throwable $e) {
                    Log::warning('tracking.hook_failed', ['error' => $e::class]);
                    report($e);
                }
            });
        } catch (Throwable $e) {
            report($e);
        }
    }
}
