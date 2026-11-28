<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Settings;

/** PHASE-8-9D §4.3, P89D-25: Google Merchant Center (Merchant API). Account and website claim are read-only here. */
final class GoogleMerchantSettings extends ProviderSettings
{
    public static function defaults(): array
    {
        return self::feedDefaults() + ['merchant_id' => null, 'account_name' => null, 'website_claimed' => false, 'feed_language' => 'bn', 'condition' => 'new'];
    }

    public static function writable(): array
    {
        return ['include', 'category_ids', 'hide_sold_out', 'use_sale_price', 'feed_language', 'condition'];
    }

    protected static function rules(): array
    {
        return self::feedRules() + [
            'feed_language' => ['required', 'string', 'in:bn,en'],
            'condition' => ['required', 'string', 'in:new,used,refurbished'],
        ];
    }

    protected static function normalize(array $settings): array
    {
        return self::normalizeFeed($settings);
    }
}
