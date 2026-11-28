<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Orders\Models\Order;

/** PHASE-8-8E P88E-15: the shopper order email's Reply-To when the store's email channel is on (else null). */
final class InboxEmail
{
    public static function orderReplyTo(Order $order): ?string
    {
        if (! InboxSettingsService::emailAvailable()) {
            return null;
        }
        $on = (bool) InboxSetting::query()->where('store_id', $order->store_id)->value('email_enabled');

        return $on ? ReplyAddress::order($order->id) : null;
    }
}
