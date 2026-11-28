<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3: Meta Pixel + Conversions API. Credential: the CAPI access token (write-only). */
final class MetaPixelSettings extends ProviderSettings
{
    public static function defaults(): array
    {
        return ['pixel_id' => null] + self::trackingDefaults() + ['mirror_browser_events' => true, 'test_event_code' => null];
    }

    public static function writable(): array
    {
        return array_keys(self::defaults());
    }

    public static function idFields(): array
    {
        return [
            'pixel_id' => ['/^\d{10,20}$/', 'Pixel ID', false, true],
            'test_event_code' => [self::TEST_CODE_PATTERN, 'test event code', false, false],
        ];
    }

    public static function credentialFields(): array
    {
        return ['access_token' => [20, 512]];
    }

    protected static function rules(): array
    {
        return self::trackingRules() + ['mirror_browser_events' => ['required', 'boolean:strict']];
    }
}
