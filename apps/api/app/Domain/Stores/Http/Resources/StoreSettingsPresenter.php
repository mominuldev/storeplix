<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Orders\Notifications\StoreCommerce;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Themes\Models\StoreTheme;
use App\Domain\Themes\ThemeRegistry;

/** StoreSettings (@storeplix/types). */
final class StoreSettingsPresenter
{
    /** @return array<string, mixed> */
    public static function present(Store $store, StoreSetting $settings): array
    {
        $store->loadMissing('primaryDomain');
        $settings->loadMissing(['logo', 'favicon', 'ogImage']);
        $themeSettings = self::liveThemeSettings($store);
        $social = $settings->social_links ?? [];
        $address = $settings->business_address ?? [];
        $updated = max($store->updated_at?->getTimestamp() ?? 0, $settings->updated_at?->getTimestamp() ?? 0);

        return [
            'store_id' => $store->id,
            'identity' => [
                'name' => $store->name,
                'name_bn' => $store->name_bn,
                'slug' => $store->slug,
                'primary_domain' => $store->primaryDomain?->hostname,
                'business_categories' => array_values($store->business_categories ?? []),
            ],
            'branding' => [
                'logo' => MediaPresenter::ref($settings->logo),
                'favicon' => MediaPresenter::ref($settings->favicon),
                'primary_color' => (string) ($themeSettings['primaryColor'] ?? ''),
                'secondary_color' => (string) ($themeSettings['secondaryColor'] ?? ''),
            ],
            'contact' => self::contact($settings),
            'social' => [
                'facebook' => $social['facebook'] ?? null,
                'instagram' => $social['instagram'] ?? null,
                'youtube' => $social['youtube'] ?? null,
            ],
            'address' => [
                'street' => $address['street'] ?? null,
                'division' => $address['division'] ?? null,
                'district' => $address['district'] ?? null,
                'area' => $address['area'] ?? null,
                'postcode' => $address['postcode'] ?? null,
                'use_for_returns' => (bool) $settings->use_address_for_returns,
            ],
            'region' => [
                'country' => $store->country,
                'currency' => $store->currency,
                'timezone' => $store->timezone,
            ],
            'seo' => [
                'title' => $settings->seo_title,
                'description' => $settings->seo_description,
                'share_image' => MediaPresenter::ref($settings->ogImage),
                'hide_from_search' => (bool) $settings->noindex,
            ],
            'commerce' => StoreCommerce::present($store, $settings),
            'updated_at' => gmdate('Y-m-d\TH:i:s\Z', $updated),
        ];
    }

    /**
     * Global settings of the live (published) active theme; registry defaults when none (P3-8).
     *
     * @return array<string, mixed>
     */
    public static function liveThemeSettings(Store $store): array
    {
        $theme = StoreTheme::query()->where('store_id', $store->id)->where('is_active', true)->first();
        $config = $theme?->published_config ?? $theme?->draft_config;
        if ($config === null) {
            $registry = app(ThemeRegistry::class);
            $config = $registry->defaults($registry->defaultCode());
        }

        return is_array($config['settings'] ?? null) ? $config['settings'] : [];
    }

    /** @return array{phone: string|null, email: string|null, whatsapp: string|null, support_hours: string|null} */
    public static function contact(?StoreSetting $settings): array
    {
        return [
            'phone' => $settings?->contact_phone,
            'email' => $settings?->contact_email,
            'whatsapp' => $settings?->whatsapp,
            'support_hours' => $settings?->support_hours,
        ];
    }
}
