<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3, P89D-57/58: AI product photos (On/Off). `keep_originals_days` is fixed at 30 (read-only). */
final class AiPhotosSettings extends ProviderSettings
{
    public const BACKGROUNDS = ['studio_white', 'soft_grey', 'warm_beige', 'pastel_pink', 'mint', 'transparent'];

    public static function defaults(): array
    {
        return ['default_background' => 'studio_white', 'keep_originals_days' => 30];
    }

    public static function writable(): array
    {
        return ['default_background'];
    }

    protected static function rules(): array
    {
        return ['default_background' => ['required', 'string', 'in:'.implode(',', self::BACKGROUNDS)]];
    }

    protected static function normalize(array $settings): array
    {
        $settings['keep_originals_days'] = 30;

        return $settings;
    }
}
