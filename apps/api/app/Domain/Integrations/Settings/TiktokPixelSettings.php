<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3: TikTok Pixel + Events API. Credential: the Events API access token (write-only). */
final class TiktokPixelSettings extends ProviderSettings
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
            'pixel_id' => ['/^[A-Z0-9]{20}$/', 'Pixel ID', true, true],
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
