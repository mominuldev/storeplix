<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\StoreSetting;

/**
 * P5-26: queues the order notifications AFTER COMMIT on the `notifications` queue. One job per (order, event), so a
 * retry never re-runs placement and sends at most one SMS per event. `$notify` (the "Send SMS" checkbox of manual
 * orders, confirm, ship and cancel) overrides the store toggle for that one action.
 */
class OrderNotifier
{
    public const QUEUE = 'notifications';

    private static bool $muted = false;

    /** Seeders and backfills: run without queuing any notification. @template T @param callable(): T $callback @return T */
    public static function muted(callable $callback): mixed
    {
        $previous = self::$muted;
        self::$muted = true;
        try {
            return $callback();
        } finally {
            self::$muted = $previous;
        }
    }

    public function placed(Order $order, ?bool $notify): void
    {
        if (self::$muted) {
            return;
        }
        $this->sms($order, 'order_placed', $notify);
        if ($order->customer_email !== null) {
            SendOrderMail::dispatch($order->id, SendOrderMail::SHOPPER_PLACED)->forTenant($order->tenant_id)->onQueue(self::QUEUE)->afterCommit();
        }
        $settings = StoreSetting::query()->where('store_id', $order->store_id)->first();
        if ((bool) ($settings?->notify_new_order_email ?? true)) {
            SendOrderMail::dispatch($order->id, SendOrderMail::MERCHANT_NEW)->forTenant($order->tenant_id)->onQueue(self::QUEUE)->afterCommit();
        }
    }

    /** $ref: per-occurrence dedupe key for events that can repeat (order_updated: the items_edited event id). */
    public function sms(Order $order, string $event, ?bool $notify, ?string $carrier = null, ?string $ref = null): void
    {
        if (self::$muted) {
            return;
        }
        $settings = StoreSetting::query()->where('store_id', $order->store_id)->first();
        $toggles = (array) ($settings?->customer_sms ?? []) + StoreCommerce::SMS_DEFAULTS;
        if (! ($notify ?? (bool) ($toggles[$event] ?? false))) {
            return;
        }
        SendOrderSms::dispatch($order->id, $event, $carrier, $ref)->forTenant($order->tenant_id)->onQueue(self::QUEUE)->afterCommit();
    }
}
