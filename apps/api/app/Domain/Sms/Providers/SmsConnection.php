<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use LogicException;
use SensitiveParameter;

/**
 * PHASE-8-9B §4.1 (S220): decrypted credentials + settings + timeout of one provider, alive only for one call. Never
 * serialised (throws), `__debugInfo` redacts, and `redact()` strips every secret from provider text before it reaches a
 * log line, an exception or an API response. `trusted` = the environment bootstrap account (config, not staff input):
 * its endpoint skips the DNS pin.
 */
final class SmsConnection
{
    /**
     * @param  array<string, string>  $credentials
     * @param  array<string, mixed>  $settings  account_id, base_url, http mapping
     */
    public function __construct(
        #[SensitiveParameter] private readonly array $credentials,
        public readonly array $settings,
        public readonly int $timeoutSeconds = 10,
        public readonly ?string $providerId = null,
        public readonly bool $trusted = false,
        public readonly int $connectRetries = 2,
    ) {}

    public function credential(string $key): string
    {
        return (string) ($this->credentials[$key] ?? '');
    }

    /** @return array<string, string> */
    public function credentials(): array
    {
        return $this->credentials;
    }

    public function setting(string $key): mixed
    {
        return $this->settings[$key] ?? null;
    }

    public function baseUrl(): string
    {
        return rtrim((string) ($this->settings['base_url'] ?? ''), '/');
    }

    /** Removes every credential value (and its URL-encoded form) from a text. */
    public function redact(?string $text): ?string
    {
        if ($text === null) {
            return null;
        }
        foreach ($this->credentials as $secret) {
            $secret = (string) $secret;
            if (mb_strlen($secret) >= 3) {
                $text = str_replace([$secret, rawurlencode($secret), urlencode($secret)], '[redacted]', $text);
            }
        }

        return $text;
    }

    /** @return array<string, mixed> */
    public function __debugInfo(): array
    {
        return ['credentials' => array_map(fn () => '[redacted]', $this->credentials), 'settings' => $this->settings,
            'timeoutSeconds' => $this->timeoutSeconds, 'providerId' => $this->providerId];
    }

    public function __serialize(): array
    {
        throw new LogicException('SMS connections are never serialised.');
    }

    public function __sleep(): array
    {
        throw new LogicException('SMS connections are never serialised.');
    }
}
