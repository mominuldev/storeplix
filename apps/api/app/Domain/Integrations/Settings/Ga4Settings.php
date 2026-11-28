<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3: GA4 + Measurement Protocol (never mirrors browser events, P89D-10). Credential: the MP API secret. */
final class Ga4Settings extends ProviderSettings
{
    public static function defaults(): array
    {
        return ['measurement_id' => null] + self::trackingDefaults() + ['send_refunds' => true];
    }

    public static function writable(): array
    {
        return array_keys(self::defaults());
    }

    public static function idFields(): array
    {
        return ['measurement_id' => ['/^G-[A-Z0-9]{4,12}$/', 'Measurement ID', true, true]];
    }

    public static function credentialFields(): array
    {
        return ['api_secret' => [8, 128]];
    }

    protected static function rules(): array
    {
        return self::trackingRules() + ['send_refunds' => ['required', 'boolean:strict']];
    }
}
