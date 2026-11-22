<?php

namespace App\Domain\Orders;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;

/** Writes append-only order_events rows. */
final class OrderTimeline
{
    /** @param array<string, mixed> $meta */
    public static function record(Order $order, string $type, ?User $user = null, ?string $body = null, array $meta = [], ?string $from = null, ?string $to = null, ?string $actorType = null): OrderEvent
    {
        $event = new OrderEvent;
        $event->store_id = $order->store_id;
        $event->order_id = $order->id;
        $event->type = $type;
        $event->from_status = $from;
        $event->to_status = $to;
        $event->actor_type = $actorType ?? ($user !== null ? 'user' : 'system');
        $event->actor_user_id = $user?->getKey();
        $event->body = $body;
        $event->meta = $meta;
        $event->created_at = now();
        $event->save();

        return $event;
    }
}
