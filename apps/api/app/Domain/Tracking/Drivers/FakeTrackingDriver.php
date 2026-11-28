<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tracking\Models\TrackingEvent;

/**
 * TRACKING_FAKE=true (local / QA, never production): no provider call; every delivery and check succeeds. A pixel or
 * token containing "FAIL" / "fail" answers like a dead token so QA can walk the auth-failure path.
 */
final class FakeTrackingDriver implements TrackingDriver
{
    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult
    {
        return $this->failing($integration) ? DeliveryResult::fail(DeliveryResult::AUTH, 401, 'Invalid access token (fake).') : DeliveryResult::ok(200);
    }

    public function check(StoreIntegration $integration): DeliveryResult
    {
        return $this->failing($integration) ? DeliveryResult::fail(DeliveryResult::AUTH, 401) : DeliveryResult::ok(200, 'Storeplix test pixel');
    }

    private function failing(StoreIntegration $integration): bool
    {
        foreach ($integration->secrets() as $value) {
            if (is_string($value) && str_contains(strtolower($value), 'fail')) {
                return true;
            }
        }

        return false;
    }
}
