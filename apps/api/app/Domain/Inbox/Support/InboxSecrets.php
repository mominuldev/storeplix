<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

/**
 * The Inbox HMAC keys (config/inbox.php). Each falls back to a purpose-bound key derived from APP_KEY, so a missing
 * env value never means an empty key. Never logged.
 */
final class InboxSecrets
{
    public static function reply(): string
    {
        return self::get('inbox.reply_secret', 'inbox-reply');
    }

    public static function code(): string
    {
        return self::get('inbox.code_secret', 'inbox-code');
    }

    public static function order(): string
    {
        return self::get('inbox.order_secret', 'inbox-order');
    }

    private static function get(string $key, string $purpose): string
    {
        $value = (string) config($key, '');

        return $value !== '' ? $value : hash_hmac('sha256', $purpose, (string) config('app.key'));
    }
}
