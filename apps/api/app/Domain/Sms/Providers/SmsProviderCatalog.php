<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

/** PHASE-8-9B §4.2: the driver catalogue from config('sms.drivers') → SmsProviderDriverInfo. */
final class SmsProviderCatalog
{
    public const CODES = ['revesms', 'ssl_wireless', 'alpha_sms', 'bulksmsbd', 'http'];

    /** @return array<string, mixed> */
    public static function get(string $code): array
    {
        return (array) config('sms.drivers.'.$code, []);
    }

    public static function available(string $code): bool
    {
        return (self::get($code)['status'] ?? null) === 'available';
    }

    /** @return list<array<string, mixed>> */
    public static function all(): array
    {
        $out = [];
        foreach (self::CODES as $code) {
            $d = self::get($code);
            $out[] = [
                'code' => $code,
                'name' => (string) ($d['name'] ?? $code),
                'status' => (string) ($d['status'] ?? 'coming_soon'),
                'recommended' => (bool) ($d['recommended'] ?? false),
                'btrc_approved' => (bool) ($d['btrc_approved'] ?? false),
                'price_masking_paisa' => isset($d['price_masking_paisa']) ? (int) $d['price_masking_paisa'] : null,
                'price_non_masking_paisa' => isset($d['price_non_masking_paisa']) ? (int) $d['price_non_masking_paisa'] : null,
                'features' => [
                    'masking' => (bool) ($d['features']['masking'] ?? false),
                    'dlr' => false, // Q267: no delivery reports in 8.9b
                    'unicode' => (bool) ($d['features']['unicode'] ?? false),
                    'balance' => (bool) ($d['features']['balance'] ?? false),
                ],
                'credential_fields' => array_map(self::field(...), (array) ($d['credential_fields'] ?? [])),
                'settings_fields' => array_map(self::field(...), (array) ($d['settings_fields'] ?? [])),
                'default_base_url' => $d['default_base_url'] ?? null,
            ];
        }

        return $out;
    }

    /** @return list<string> the credential keys a driver requires (http: free keys, checked separately) */
    public static function credentialKeys(string $code): array
    {
        return array_values(array_map(fn (array $f) => (string) $f['key'], array_filter((array) (self::get($code)['credential_fields'] ?? []), fn ($f) => (bool) ($f['required'] ?? true))));
    }

    /** @param array<string, mixed> $f @return array{key: string, label: string, secret: bool, required: bool, hint: string|null} */
    private static function field(array $f): array
    {
        return ['key' => (string) $f['key'], 'label' => (string) $f['label'], 'secret' => (bool) $f['secret'], 'required' => (bool) $f['required'], 'hint' => $f['hint'] ?? null];
    }
}
