<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Stores\Models\Store;

/**
 * PHASE-8-9D P89D-22 / §6.1 (S333): `StorefrontConfig.tracking` — pixel IDs, consent flag, beacon flag, currency and the
 * Google site-verification token Storeplix writes. Never a token, secret, tagging URL or test code. Null for Coming soon
 * and preview renders and when nothing is connected (the key is then omitted: byte-identical config, S349). A pixel
 * whose server token stopped working (`error`) still renders: the browser tag needs only the ID.
 */
final class StorefrontTracking
{
    public const PATTERNS = [
        'meta_pixel_id' => '/^\d{10,20}$/',
        'ga4_measurement_id' => '/^G-[A-Z0-9]{4,12}$/',
        'tiktok_pixel_id' => '/^[A-Z0-9]{20}$/',
        'google' => '/^[A-Za-z0-9_-]{10,100}$/',
    ];

    /** @return array<string, mixed>|null */
    public static function config(Store $store, bool $preview): ?array
    {
        if ($preview || $store->status !== Store::STATUS_ACTIVE) {
            return null;
        }
        $rows = StoreIntegration::query()->where('store_id', $store->id)
            ->whereIn('provider', [...IntegrationProvider::TRACKING, IntegrationProvider::GOOGLE_MERCHANT])
            ->whereIn('status', [...StoreIntegration::ACTIVE, StoreIntegration::ERROR])->get()->keyBy('provider');
        if ($rows->isEmpty()) {
            return null;
        }
        $id = fn (string $provider, string $key, string $pattern) => ($v = $rows->get($provider)?->setting($key)) !== null && is_string($v) && preg_match($pattern, $v) === 1 ? $v : null;
        $tracking = $rows->filter(fn (StoreIntegration $i) => IntegrationProvider::isTracking($i->provider) && TrackingIntegrations::planAllows($i));
        $verification = null;
        $merchant = $rows->get(IntegrationProvider::GOOGLE_MERCHANT);
        if ($merchant !== null && TrackingIntegrations::planAllows($merchant)) {
            $token = $merchant->secrets()['site_verification_token'] ?? null;
            $verification = is_string($token) && preg_match(self::PATTERNS['google'], $token) === 1 ? $token : null;
        }
        if ($tracking->isEmpty() && $verification === null) {
            return null;
        }

        return [
            'meta_pixel_id' => $id(IntegrationProvider::META_PIXEL, 'pixel_id', self::PATTERNS['meta_pixel_id']),
            'ga4_measurement_id' => $id(IntegrationProvider::GA4, 'measurement_id', self::PATTERNS['ga4_measurement_id']),
            'tiktok_pixel_id' => $id(IntegrationProvider::TIKTOK_PIXEL, 'pixel_id', self::PATTERNS['tiktok_pixel_id']),
            'wait_for_consent' => $tracking->contains(fn (StoreIntegration $i) => (bool) $i->setting('wait_for_consent', false)),
            'collect' => true,
            'currency' => $store->currency ?? 'BDT',
            'site_verification' => ['google' => $verification],
        ];
    }
}
