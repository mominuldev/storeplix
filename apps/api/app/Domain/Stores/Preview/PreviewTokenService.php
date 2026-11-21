<?php

namespace App\Domain\Stores\Preview;

use App\Domain\Stores\Models\Store;
use Carbon\CarbonImmutable;

/**
 * Stateless, signed storefront preview tokens (D2).
 *
 * Format: base64url(json{s: store_id, e: unix_expiry}) "." base64url(HMAC-SHA256)
 * Key: derived from APP_KEY with a purpose label, so the token cannot be confused
 * with any other HMAC the app produces. Bound to one store; 60 minutes by default.
 */
class PreviewTokenService
{
    public const TTL_MINUTES = 60;

    /**
     * @return array{token: string, expires_at: CarbonImmutable}
     */
    public function issue(Store $store): array
    {
        $expiresAt = CarbonImmutable::now()->addMinutes(self::TTL_MINUTES);
        $payload = self::b64(json_encode(['s' => $store->getKey(), 'e' => $expiresAt->getTimestamp()], JSON_THROW_ON_ERROR));

        return ['token' => $payload.'.'.$this->sign($payload), 'expires_at' => $expiresAt];
    }

    /** True only if the token is authentic, unexpired and issued for exactly this store. */
    public function isValidFor(?string $token, string $storeId): bool
    {
        if ($token === null || $token === '' || strlen($token) > 512 || substr_count($token, '.') !== 1) {
            return false;
        }

        [$payload, $signature] = explode('.', $token, 2);

        if (! hash_equals($this->sign($payload), $signature)) {
            return false;
        }

        $data = json_decode((string) self::unb64($payload), true);

        if (! is_array($data) || ! is_string($data['s'] ?? null) || ! is_int($data['e'] ?? null)) {
            return false;
        }

        return hash_equals($storeId, $data['s']) && $data['e'] > CarbonImmutable::now()->getTimestamp();
    }

    public function previewUrl(Store $store, string $token): ?string
    {
        $host = $store->primaryDomain?->hostname;

        if ($host === null) {
            return null;
        }

        $origin = app()->environment('local') ? "http://{$host}:3000" : "https://{$host}";

        return $origin.'/?preview='.rawurlencode($token);
    }

    private function sign(string $payload): string
    {
        return self::b64(hash_hmac('sha256', $payload, $this->key(), true));
    }

    private function key(): string
    {
        $appKey = (string) config('app.key');
        if (str_starts_with($appKey, 'base64:')) {
            $appKey = base64_decode(substr($appKey, 7));
        }

        return hash_hmac('sha256', 'storeplix.storefront-preview.v1', $appKey, true);
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    private static function unb64(string $value): string|false
    {
        return base64_decode(strtr($value, '-_', '+/'), true);
    }
}
