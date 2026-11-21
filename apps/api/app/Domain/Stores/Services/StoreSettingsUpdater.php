<?php

namespace App\Domain\Stores\Services;

use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;

/**
 * Applies a partial UpdateStoreSettingsInput. Returns the list of changed keys ("section.key").
 * Colours live in store_settings.theme.settings.primaryColor/secondaryColor (single source).
 */
class StoreSettingsUpdater
{
    /** input key => [model, column] */
    private const MAP = [
        'identity.name' => ['store', 'name'],
        'identity.name_bn' => ['store', 'name_bn'],
        'identity.business_categories' => ['store', 'business_categories'],
        'region.country' => ['store', 'country'],
        'region.currency' => ['store', 'currency'],
        'region.timezone' => ['store', 'timezone'],
        'branding.logo_media_id' => ['settings', 'logo_media_id'],
        'branding.favicon_media_id' => ['settings', 'favicon_media_id'],
        'contact.phone' => ['settings', 'contact_phone'],
        'contact.email' => ['settings', 'contact_email'],
        'contact.whatsapp' => ['settings', 'whatsapp'],
        'contact.support_hours' => ['settings', 'support_hours'],
        'address.use_for_returns' => ['settings', 'use_address_for_returns'],
    ];

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  array<string, array<string, mixed>>  $input  validated, partial
     * @return list<string>
     */
    public function update(Store $store, StoreSetting $settings, array $input): array
    {
        $changed = [];

        foreach (self::MAP as $key => [$target, $column]) {
            [$section, $field] = explode('.', $key);
            if (! array_key_exists($section, $input) || ! array_key_exists($field, $input[$section])) {
                continue;
            }

            $value = $input[$section][$field];
            if (in_array($key, ['contact.phone', 'contact.whatsapp'], true) && $value !== null) {
                $value = Phone::e164($value);
            }
            if ($key === 'identity.business_categories') {
                $value = array_values(array_unique($value));
            }

            $model = $target === 'store' ? $store : $settings;
            if ($model->getAttribute($column) != $value) {
                $model->setAttribute($column, $value);
                $changed[] = $key;
            }
        }

        if (isset($input['social']) && is_array($input['social'])) {
            $social = $settings->social_links ?? [];
            foreach ($input['social'] as $network => $url) {
                if (($social[$network] ?? null) !== $url) {
                    $social[$network] = $url;
                    $changed[] = "social.{$network}";
                }
            }
            $settings->social_links = $social;
        }

        if (isset($input['address']) && is_array($input['address'])) {
            $address = $settings->business_address ?? [];
            foreach (['street', 'division', 'district', 'area', 'postcode'] as $field) {
                if (array_key_exists($field, $input['address']) && ($address[$field] ?? null) !== $input['address'][$field]) {
                    $address[$field] = $input['address'][$field];
                    $changed[] = "address.{$field}";
                }
            }
            $settings->business_address = $address;
        }

        $theme = $settings->theme ?? config('storeplix.default_theme');
        foreach (['primary_color' => 'primaryColor', 'secondary_color' => 'secondaryColor'] as $field => $themeKey) {
            if (isset($input['branding'][$field])) {
                $color = strtolower($input['branding'][$field]);
                if (($theme['settings'][$themeKey] ?? null) !== $color) {
                    $theme['settings'][$themeKey] = $color;
                    $changed[] = "branding.{$field}";
                }
            }
        }
        $settings->theme = $theme;

        if ($changed === []) {
            return [];
        }

        DB::transaction(function () use ($store, $settings) {
            $store->save();
            $settings->save();
        });

        // Redacted: changed key names only, never contact values.
        $this->audit->log('store.settings_updated', $settings, ['changes' => $changed]);

        return $changed;
    }
}
