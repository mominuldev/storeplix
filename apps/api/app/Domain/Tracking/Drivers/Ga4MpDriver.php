<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Tracking\Models\TrackingEvent;
use Throwable;

/**
 * GA4 Measurement Protocol (PHASE-8-9D §5.2): POST www.google-analytics.com/mp/collect?measurement_id&api_secret;
 * the test event uses the validation server /debug/mp/collect (its `validationMessages` are returned). GA4 never
 * receives server copies of browser events (P89D-10). `client_id` from `_ga`, else a stable per-order id.
 */
final class Ga4MpDriver extends HttpTrackingDriver
{
    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult
    {
        $secret = (string) ($integration->secrets()['api_secret'] ?? '');
        $body = self::measurementProtocolBody((string) $event->provider_event_name, $event->event_id, $payload);

        return $this->post($integration, $body, $secret, $debug);
    }

    public function check(StoreIntegration $integration): DeliveryResult
    {
        $secret = (string) ($integration->secrets()['api_secret'] ?? '');
        if ($secret === '') {
            return DeliveryResult::fail(DeliveryResult::AUTH);
        }

        return $this->post($integration, ['client_id' => 'storeplix.check', 'events' => [['name' => 'storeplix_check', 'params' => ['engagement_time_msec' => 1]]]], $secret, true);
    }

    /** @param array<string, mixed> $body */
    private function post(StoreIntegration $integration, array $body, string $secret, bool $debug): DeliveryResult
    {
        $query = http_build_query(['measurement_id' => (string) $integration->setting('measurement_id'), 'api_secret' => $secret]);
        try {
            $response = $this->http((string) config('tracking.ga4.base_url'))->post(($debug ? '/debug/mp/collect' : '/mp/collect').'?'.$query, $body);
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('ga4_mp', $debug ? 'debug' : 'collect', $response->status(), ['integration_id' => $integration->id]);
        if (! $response->successful()) {
            return self::byStatus($response, self::redact($response->body(), [$secret]));
        }
        $messages = [];
        foreach ((array) $response->json('validationMessages', []) as $m) {
            $text = self::redact(is_array($m) ? (string) ($m['description'] ?? '') : null, [$secret]);
            if ($text !== null) {
                $messages[] = $text;
            }
        }
        if ($debug && $messages !== []) {
            return new DeliveryResult(false, $response->status(), DeliveryResult::REJECTED, null, $messages[0], $messages);
        }

        return new DeliveryResult(true, $response->status(), validationMessages: $messages);
    }
}
