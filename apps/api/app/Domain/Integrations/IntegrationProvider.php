<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use App\Domain\Billing\Feature;
use App\Domain\Shared\Http\ApiException;

/**
 * PHASE-8-9D P89D-3 registry: `IntegrationProvider` values in catalogue order (types INTEGRATION_PROVIDERS), their kind
 * and the plan feature each needs (P89D-40). The value is the `{provider}` path segment verbatim.
 */
final class IntegrationProvider
{
    public const META_PIXEL = 'meta_pixel';

    public const GA4 = 'ga4';

    public const TIKTOK_PIXEL = 'tiktok_pixel';

    public const GTM_SERVER = 'gtm_server';

    public const META_CATALOG = 'meta_catalog';

    public const GOOGLE_MERCHANT = 'google_merchant';

    public const AI_WRITER = 'ai_writer';

    public const AI_PHOTOS = 'ai_photos';

    public const TRACKING = [self::META_PIXEL, self::GA4, self::TIKTOK_PIXEL, self::GTM_SERVER];

    public const FEEDS = [self::META_CATALOG, self::GOOGLE_MERCHANT];

    public const AI = [self::AI_WRITER, self::AI_PHOTOS];

    public const ALL = [...self::TRACKING, ...self::FEEDS, ...self::AI];

    /** Route constraint for `{provider}`. */
    public const PATTERN = 'meta_pixel|ga4|tiktok_pixel|gtm_server|meta_catalog|google_merchant|ai_writer|ai_photos';

    /** Display names (audit meta, emails). */
    public const LABELS = [
        self::META_PIXEL => 'Meta Pixel', self::GA4 => 'Google Analytics 4', self::TIKTOK_PIXEL => 'TikTok Pixel',
        self::GTM_SERVER => 'Google Tag Manager', self::META_CATALOG => 'Facebook & Instagram catalog',
        self::GOOGLE_MERCHANT => 'Google Merchant Center', self::AI_WRITER => 'Claude product descriptions', self::AI_PHOTOS => 'AI product photos',
    ];

    public static function kind(string $provider): string
    {
        return in_array($provider, self::TRACKING, true) ? 'tracking' : (in_array($provider, self::FEEDS, true) ? 'feed' : 'ai');
    }

    public static function isTracking(string $provider): bool
    {
        return in_array($provider, self::TRACKING, true);
    }

    public static function isFeed(string $provider): bool
    {
        return in_array($provider, self::FEEDS, true);
    }

    public static function isAi(string $provider): bool
    {
        return in_array($provider, self::AI, true);
    }

    /** P89D-40: the plan feature a provider needs (null = every plan). */
    public static function feature(string $provider): ?Feature
    {
        return match (true) {
            self::isFeed($provider) => Feature::ProductFeeds,
            $provider === self::GTM_SERVER => Feature::ServerSideTagging,
            default => null,
        };
    }

    /** 404 for anything outside the registry. */
    public static function assert(string $provider): string
    {
        return in_array($provider, self::ALL, true) ? $provider : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** 404 unless the provider is one of $allowed (e.g. tracking-only routes). @param list<string> $allowed */
    public static function assertIn(string $provider, array $allowed): string
    {
        return in_array($provider, $allowed, true) ? $provider : throw new ApiException(404, 'not_found', 'Resource not found.');
    }
}
