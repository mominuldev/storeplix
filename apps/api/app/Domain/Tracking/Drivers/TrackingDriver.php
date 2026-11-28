<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Tracking\Models\TrackingEvent;

/**
 * PHASE-8-9D §5.2: one server-side destination. Secrets come from the integration row at call time; the event's payload
 * holds only the hashed user block, client context and values. Never throws for provider errors (returns a result).
 */
interface TrackingDriver
{
    /**
     * @param  array<string, mixed>  $payload  TrackingPayloads shape
     * @param  bool  $debug  GA4 / GTM: the validation endpoint (Send test event)
     */
    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult;

    /** Live credential / endpoint check (§4.2, §4.5); `foundName` = pixel name when the provider reports it. */
    public function check(StoreIntegration $integration): DeliveryResult;
}
