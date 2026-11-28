<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

/**
 * P88E-2 thread keys: `UNIQUE(store_id, channel, thread_key)` makes one conversation per contact per channel thread.
 */
final class ThreadKey
{
    public static function phone(string $msisdn): string
    {
        return 'phone:'.$msisdn;
    }

    public static function session(string $sessionId): string
    {
        return 'session:'.strtolower($sessionId);
    }

    public static function order(string $orderId): string
    {
        return 'order:'.strtolower($orderId);
    }

    public static function email(string $address): string
    {
        return 'email:'.mb_substr(strtolower(trim($address)), 0, 290);
    }
}
