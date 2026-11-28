<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3, P89D-24: Facebook & Instagram catalog. The business / catalog are chosen after OAuth (read-only here). */
final class MetaCatalogSettings extends ProviderSettings
{
    public static function defaults(): array
    {
        return self::feedDefaults() + ['business_id' => null, 'business_name' => null, 'catalog_id' => null, 'catalog_name' => null, 'default_brand' => null];
    }

    public static function writable(): array
    {
        return ['include', 'category_ids', 'hide_sold_out', 'use_sale_price', 'default_brand'];
    }

    protected static function rules(): array
    {
        return self::feedRules() + ['default_brand' => ['present', 'nullable', 'string', 'max:70']];
    }

    protected static function normalize(array $settings): array
    {
        $settings = self::normalizeFeed($settings);
        $brand = is_string($settings['default_brand']) ? trim(strip_tags($settings['default_brand'])) : '';
        $settings['default_brand'] = $brand === '' ? null : $brand;

        return $settings;
    }
}
