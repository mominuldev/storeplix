<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

/**
 * PHASE-8-9D P89D-19 / §5.8: the signed test-mode token `{store, integration, exp}` carried by `?sp_test=` and then the
 * httpOnly `sp_track_test` cookie (30 min). HMAC-SHA256 with a key derived from APP_KEY; compared in constant time.
 */
final class TrackingTestMode
{
    public static function token(string $storeId, string $integrationId, int $expiresAt): string
    {
        $body = rtrim(strtr(base64_encode((string) json_encode(['s' => $storeId, 'i' => $integrationId, 'e' => $expiresAt])), '+/', '-_'), '=');

        return $body.'.'.self::mac($body);
    }

    /** The integration id the token is valid for, in this store, now; null otherwise. */
    public static function integrationFor(?string $token, string $storeId): ?string
    {
        if (! is_string($token) || strlen($token) > 400 || substr_count($token, '.') !== 1) {
            return null;
        }
        [$body, $mac] = explode('.', $token);
        if (! hash_equals(self::mac($body), $mac)) {
            return null;
        }
        $data = json_decode((string) base64_decode(strtr($body, '-_', '+/'), true), true);
        if (! is_array($data) || ($data['s'] ?? null) !== $storeId || ! is_int($data['e'] ?? null) || $data['e'] < now()->getTimestamp()) {
            return null;
        }

        return is_string($data['i'] ?? null) ? $data['i'] : null;
    }

    private static function mac(string $body): string
    {
        return hash_hmac('sha256', $body, 'storeplix-track-test|'.config('app.key'));
    }
}
