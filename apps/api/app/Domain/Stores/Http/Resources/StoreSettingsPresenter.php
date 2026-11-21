<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;

/** StoreSettings (@storeplix/types). */
final class StoreSettingsPresenter
{
    /** @return array<string, mixed> */
    public static function present(Store $store, StoreSetting $settings): array
    {
        $store->loadMissing('primaryDomain');
        $settings->loadMissing(['logo', 'favicon']);
        $theme = ThemeConfigPresenter::present($settings->theme ?? []);
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
                'primary_color' => (string) $theme['settings']->primaryColor,
                'secondary_color' => (string) $theme['settings']->secondaryColor,
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
            'updated_at' => gmdate('Y-m-d\TH:i:s\Z', $updated),
        ];
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
