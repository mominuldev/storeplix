<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;

/** PHASE-8-9D §5.1 (types TRACKING_EVENT_NAMES): canonical event → provider event name; null = not sent. */
final class TrackingEventNames
{
    public const BROWSER = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout'];

    public const ALL = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];

    private const NAMES = [
        IntegrationProvider::META_PIXEL => ['page_view' => 'PageView', 'view_item' => 'ViewContent', 'add_to_cart' => 'AddToCart', 'begin_checkout' => 'InitiateCheckout', 'purchase' => 'Purchase', 'refund' => null],
        IntegrationProvider::GA4 => ['page_view' => 'page_view', 'view_item' => 'view_item', 'add_to_cart' => 'add_to_cart', 'begin_checkout' => 'begin_checkout', 'purchase' => 'purchase', 'refund' => 'refund'],
        IntegrationProvider::TIKTOK_PIXEL => ['page_view' => 'Pageview', 'view_item' => 'ViewContent', 'add_to_cart' => 'AddToCart', 'begin_checkout' => 'InitiateCheckout', 'purchase' => 'CompletePayment', 'refund' => null],
        IntegrationProvider::GTM_SERVER => ['page_view' => 'page_view', 'view_item' => 'view_item', 'add_to_cart' => 'add_to_cart', 'begin_checkout' => 'begin_checkout', 'purchase' => 'purchase', 'refund' => 'refund'],
    ];

    public static function for(string $provider, string $event): ?string
    {
        return self::NAMES[$provider][$event] ?? null;
    }

    /** Events this integration receives (GTM: only the selected ones). @return list<string> */
    public static function received(StoreIntegration $integration): array
    {
        $events = array_keys(array_filter(self::NAMES[$integration->provider] ?? [], fn ($name) => $name !== null));
        if ($integration->provider === IntegrationProvider::GTM_SERVER) {
            $events = array_values(array_intersect($events, (array) $integration->setting('events', [])));
        }

        return array_values($events);
    }
}
