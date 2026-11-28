<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\IntegrationProvider;
use InvalidArgumentException;

/** Driver per feed provider; FEEDS_FAKE swaps both for FakeFeedDriver (refused in production). */
class FeedDrivers
{
    public function for(string $provider): FeedDriver
    {
        if ((bool) config('feeds.fake')) {
            return app(FakeFeedDriver::class);
        }

        return match ($provider) {
            IntegrationProvider::META_CATALOG => app(MetaCatalogDriver::class),
            IntegrationProvider::GOOGLE_MERCHANT => app(GoogleMerchantDriver::class),
            default => throw new InvalidArgumentException("No feed driver for {$provider}."),
        };
    }
}
