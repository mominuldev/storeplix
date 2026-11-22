<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Shared\Http\UserRef;

/**
 * CourierAccount (@storeplix/types, openapi v1.6.0), keys in contract order. An explicit allowlist: credentials,
 * the webhook secret (only its hint), the route key (only inside webhook_url) never appear (S26). Absent providers →
 * `not_connected` with default settings.
 */
final class CourierAccountPresenter
{
    /** @return array<string, mixed> */
    public static function present(?CourierAccount $a, string $provider): array
    {
        $driver = app(CourierManager::class)->driver($provider);
        $active = $a !== null && $a->status !== CourierAccount::DISCONNECTED;

        return [
            'provider' => $provider,
            'status' => $a?->status ?? CourierAccount::NOT_CONNECTED,
            'mode' => $active ? $a->mode : null,
            'credentials_hint' => $active ? $a->credentials_hint : null,
            'is_default' => $a?->is_default ?? false,
            'settings' => self::settings($a, $provider),
            'webhook_url' => $active && $driver->supportsWebhooks() ? self::webhookUrl($a) : null,
            'webhook_secret_hint' => $active && $driver->supportsWebhooks() && $a->webhook_secret_encrypted !== null
                ? IntegrationCredentials::hint((string) $a->webhookSecret()) : null,
            'capabilities' => $driver->capabilities(),
            'last_synced_at' => UserRef::iso($a?->last_synced_at),
            'last_webhook_at' => UserRef::iso($a?->last_webhook_at),
            'last_error_code' => $a?->last_error_code,
            'connected_by' => $active ? UserRef::of($a->connectedBy) : null,
            'connected_at' => $active ? UserRef::iso($a->connected_at) : null,
            'revision' => $a?->revision ?? 0,
        ];
    }

    /** CourierSettings in contract order; Pathao/RedX keys only for their provider. */
    public static function settings(?CourierAccount $a, string $provider): array
    {
        $s = $a?->resolvedSettings() ?? CourierAccount::DEFAULT_SETTINGS;
        $out = [
            'pickup_location_id' => $a?->pickup_location_id,
            'parcel_description' => (string) ($s['parcel_description'] ?? CourierAccount::DEFAULT_SETTINGS['parcel_description']),
            'default_weight_grams' => (int) ($s['default_weight_grams'] ?? CourierAccount::DEFAULT_SETTINGS['default_weight_grams']),
        ];
        if ($provider === CourierAccount::PATHAO) {
            $out['pathao_store_id'] = isset($s['pathao_store_id']) ? (string) $s['pathao_store_id'] : null;
            $out['delivery_type'] = (int) ($s['delivery_type'] ?? 48);
        }
        if ($provider === CourierAccount::REDX) {
            $out['redx_pickup_store_id'] = isset($s['redx_pickup_store_id']) ? (string) $s['redx_pickup_store_id'] : null;
        }

        return $out;
    }

    /** The URL the merchant pastes in the courier panel (PUBLIC_API_URL + /api/v1/webhooks/{provider}/{route_key}). */
    public static function webhookUrl(CourierAccount $a): string
    {
        return rtrim((string) (config('payments.public_api_url') ?: config('app.url')), '/').'/api/v1/webhooks/'.$a->provider.'/'.$a->route_key;
    }
}
