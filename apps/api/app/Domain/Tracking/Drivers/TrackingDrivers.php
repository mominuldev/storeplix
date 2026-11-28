<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\IntegrationProvider;
use InvalidArgumentException;

/** Driver per tracking provider; TRACKING_FAKE swaps every one for FakeTrackingDriver (refused in production). */
class TrackingDrivers
{
    public function for(string $provider): TrackingDriver
    {
        if ((bool) config('tracking.fake')) {
            return app(FakeTrackingDriver::class);
        }

        return match ($provider) {
            IntegrationProvider::META_PIXEL => app(MetaCapiDriver::class),
            IntegrationProvider::GA4 => app(Ga4MpDriver::class),
            IntegrationProvider::TIKTOK_PIXEL => app(TiktokEventsDriver::class),
            IntegrationProvider::GTM_SERVER => app(GtmServerDriver::class),
            default => throw new InvalidArgumentException("No tracking driver for {$provider}."),
        };
    }
}
