<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

/**
 * Stateless order access for the order-page Messages (PHASE-8-8E §10, S237): `base64url("{order_id}.{exp}")` + "." +
 * base64url(HMAC-SHA256(INBOX_ORDER_SECRET, "{tenant}|{store}|{order_id}|{exp}")). Bound to tenant + store: a token
 * of another shop never verifies. 12 h from track, 24 h from confirmation, 7 days from a magic link.
 */
final class OrderAccessToken
{
    public const TRACK_SECONDS = 12 * 3600;

    public const CONFIRMATION_SECONDS = 24 * 3600;

    public const LINK_SECONDS = 7 * 86400;

    public static function issue(string $tenantId, string $storeId, string $orderId, int $ttlSeconds): string
    {
        $exp = now()->getTimestamp() + $ttlSeconds;
        $payload = strtolower($orderId).'.'.$exp;

        return self::b64($payload).'.'.self::b64(self::mac($tenantId, $storeId, strtolower($orderId), $exp, true));
    }

    /** The order id of a valid, unexpired token of this tenant + store; else null. */
    public static function verify(?string $token, string $tenantId, string $storeId): ?string
    {
        $parsed = self::parse($token);
        if ($parsed === null) {
            return null;
        }
        [$orderId, $exp, $sig] = $parsed;
        if ($exp < now()->getTimestamp()) {
            return null;
        }

        return hash_equals(self::mac($tenantId, $storeId, $orderId, $exp, true), $sig) ? $orderId : null;
    }

    /** Unverified order id (limiter keys only). */
    public static function peekOrderId(?string $token): ?string
    {
        return self::parse($token)[0] ?? null;
    }

    /** @return array{0: string, 1: int, 2: string}|null */
    private static function parse(?string $token): ?array
    {
        if ($token === null || strlen($token) > 200 || substr_count($token, '.') !== 1) {
            return null;
        }
        [$payload, $sig] = explode('.', $token);
        $payload = self::unb64($payload);
        $sig = self::unb64($sig);
        if ($payload === null || $sig === null || preg_match('/^([0-9a-hjkmnp-tv-z]{26})\.(\d{1,12})$/', $payload, $m) !== 1) {
            return null;
        }

        return [$m[1], (int) $m[2], $sig];
    }

    private static function mac(string $tenantId, string $storeId, string $orderId, int $exp, bool $raw): string
    {
        return hash_hmac('sha256', strtolower($tenantId).'|'.strtolower($storeId).'|'.$orderId.'|'.$exp, InboxSecrets::order(), $raw);
    }

    private static function b64(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private static function unb64(string $value): ?string
    {
        if ($value === '' || preg_match('/^[A-Za-z0-9_-]+$/', $value) !== 1) {
            return null;
        }
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);

        return $decoded === false ? null : $decoded;
    }
}
