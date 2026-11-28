<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3, P89D-54: the Claude product description writer (On/Off; the generation API is part B). */
final class AiWriterSettings extends ProviderSettings
{
    public static function defaults(): array
    {
        return ['default_language' => 'bn', 'default_tone' => 'friendly', 'default_length' => 'medium', 'use_product_image' => true];
    }

    public static function writable(): array
    {
        return array_keys(self::defaults());
    }

    protected static function rules(): array
    {
        return [
            'default_language' => ['required', 'string', 'in:bn,en'],
            'default_tone' => ['required', 'string', 'in:friendly,professional,playful,premium'],
            'default_length' => ['required', 'string', 'in:short,medium,long'],
            'use_product_image' => ['required', 'boolean:strict'],
        ];
    }
}
