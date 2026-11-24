<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use SensitiveParameter;

/**
 * P84-8 (S108): `X-Storeplix-Signature: t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<raw body>"). During the
 * 24 h after a rotation a second `v1=` signed with the previous secret is appended. Receivers recompute v1 with their
 * secret over the exact raw body and accept when any v1 matches and t is recent.
 */
final class WebhookSigner
{
    public const HEADER = 'X-Storeplix-Signature';

    public static function v1(#[SensitiveParameter] string $secret, int $timestamp, string $body): string
    {
        return hash_hmac('sha256', $timestamp.'.'.$body, $secret);
    }

    /** @param list<string> $secrets current first, then the previous one while it overlaps */
    public static function header(#[SensitiveParameter] array $secrets, int $timestamp, string $body): string
    {
        $parts = ['t='.$timestamp];
        foreach ($secrets as $secret) {
            $parts[] = 'v1='.self::v1($secret, $timestamp, $body);
        }

        return implode(',', $parts);
    }

    /** Receiver-side check (documented algorithm; used by tests and the docs example). */
    public static function verify(#[SensitiveParameter] string $secret, string $header, string $body, int $toleranceSeconds = 300, ?int $now = null): bool
    {
        $timestamp = null;
        $signatures = [];
        foreach (explode(',', $header) as $part) {
            [$key, $value] = array_pad(explode('=', trim($part), 2), 2, '');
            if ($key === 't' && ctype_digit($value)) {
                $timestamp = (int) $value;
            } elseif ($key === 'v1') {
                $signatures[] = $value;
            }
        }
        if ($timestamp === null || abs(($now ?? time()) - $timestamp) > $toleranceSeconds) {
            return false;
        }
        $expected = self::v1($secret, $timestamp, $body);
        foreach ($signatures as $signature) {
            if (hash_equals($expected, $signature)) {
                return true;
            }
        }

        return false;
    }

    /** The header as shown in the delivery log: timestamp kept, signatures redacted. */
    public static function redact(string $header): string
    {
        return (string) preg_replace('/v1=[0-9a-f]+/', 'v1=••••', $header);
    }
}
