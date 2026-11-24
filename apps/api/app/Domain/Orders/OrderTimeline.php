<?php

namespace App\Domain\Orders;

use App\Domain\Developer\ApiKeys\CurrentApiKey;
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
        // PHASE-8-4 §3: a write through the external API is recorded with the API key as the actor.
        if ($actorType === null && $user === null && ($key = CurrentApiKey::current()) !== null) {
            $event->actor_type = 'api_key';
            $event->actor_api_key_id = $key->id;
        }
        $event->body = $body;
        $event->meta = $meta;
        $event->created_at = now();
        $event->save();

        return $event;
    }
}
