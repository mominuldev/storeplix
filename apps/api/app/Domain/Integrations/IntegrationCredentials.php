<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Encryption\Encrypter;
use JsonException;
use RuntimeException;
use SensitiveParameter;

/**
 * Dedicated encrypter for merchant integration secrets (PHASE-5B-CONTRACT P5B-10, S26): gateway and courier
 * credentials, webhook secrets. Keyed by INTEGRATION_CREDENTIALS_KEY (never APP_KEY, so an APP_KEY rotation can't
 * lose or expose them); INTEGRATION_CREDENTIALS_PREVIOUS_KEYS (comma-separated) still decrypt during a rotation
 * (`php artisan integrations:rotate-key` re-encrypts every value with the current key).
 *
 * Values are never logged or returned: callers get plain arrays only inside drivers, and models hide the column.
 * Outside production a missing key falls back to a key derived from APP_KEY so local/testing work without setup.
 */
final class IntegrationCredentials
{
    private const CIPHER = 'AES-256-GCM';

    private ?Encrypter $current = null;

    /** @var list<Encrypter>|null */
    private ?array $previous = null;

    /** @param array<string, mixed> $credentials */
    public function encrypt(#[SensitiveParameter] array $credentials): string
    {
        return $this->encryptString(json_encode($credentials, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
    }

    /** @return array<string, mixed> */
    public function decrypt(string $payload): array
    {
        try {
            $data = json_decode($this->decryptString($payload), true, 4, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new DecryptException('Integration credentials are not valid JSON.');
        }

        return is_array($data) ? $data : throw new DecryptException('Integration credentials are not an object.');
    }

    public function encryptString(#[SensitiveParameter] string $value): string
    {
        return $this->current()->encryptString($value);
    }

    /** Tries the current key, then each previous key. @throws DecryptException */
    public function decryptString(string $payload): string
    {
        foreach ([$this->current(), ...$this->previous()] as $encrypter) {
            try {
                return $encrypter->decryptString($payload);
            } catch (DecryptException) {
                continue;
            }
        }

        throw new DecryptException('Integration credentials could not be decrypted with any configured key.');
    }

    /** True when the payload decrypts with the current key (nothing to rotate). */
    public function isCurrent(string $payload): bool
    {
        try {
            $this->current()->decryptString($payload);

            return true;
        } catch (DecryptException) {
            return false;
        }
    }

    /** Re-encrypts a payload with the current key (decrypting with any configured key). */
    public function reencrypt(string $payload): string
    {
        return $this->encryptString($this->decryptString($payload));
    }

    /** Last four characters behind a mask: "••••3f9a" (P5B-10 credentials_hint). */
    public static function hint(#[SensitiveParameter] string $value): string
    {
        $value = trim($value);

        return '••••'.(mb_strlen($value) <= 4 ? '' : mb_substr($value, -4));
    }

    private function current(): Encrypter
    {
        return $this->current ??= new Encrypter(self::parseKey($this->currentKey()), self::CIPHER);
    }

    /** @return list<Encrypter> */
    private function previous(): array
    {
        if ($this->previous === null) {
            $keys = array_filter(array_map('trim', explode(',', (string) config('integrations.previous_keys', ''))));
            $this->previous = array_values(array_map(fn (string $k) => new Encrypter(self::parseKey($k), self::CIPHER), $keys));
        }

        return $this->previous;
    }

    private function currentKey(): string
    {
        $key = (string) config('integrations.key', '');
        if ($key !== '') {
            return $key;
        }
        if (app()->environment('production')) {
            throw new RuntimeException('INTEGRATION_CREDENTIALS_KEY is not set.');
        }

        // local / testing only: a stable key derived from APP_KEY (never used in production).
        return 'base64:'.base64_encode(hash('sha256', 'storeplix-integration-credentials|'.config('app.key'), true));
    }

    private static function parseKey(string $key): string
    {
        $raw = str_starts_with($key, 'base64:') ? base64_decode(substr($key, 7), true) : base64_decode($key, true);
        if (! is_string($raw) || strlen($raw) !== 32) {
            throw new RuntimeException('Integration credentials keys must be 32 bytes, base64-encoded.');
        }

        return $raw;
    }
}
