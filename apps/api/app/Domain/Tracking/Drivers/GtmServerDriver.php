<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\PublicEndpointGuard;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Http\Client\PendingRequest;
use InvalidArgumentException;
use Throwable;

/**
 * GTM server container (PHASE-8-9D P89D-9, §5.2): POST {tagging_server_url}/mp/collect?measurement_id with the GA4 MP
 * body. The merchant URL passes PublicEndpointGuard on every send and the request is pinned to the checked address
 * (CURLOPT_RESOLVE): https, 443, public resolution, no redirects, 5 s / 10 s (S334). Health check: GET {url}/healthy.
 */
final class GtmServerDriver extends HttpTrackingDriver
{
    public function __construct(private readonly PublicEndpointGuard $guard) {}

    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult
    {
        $url = (string) $integration->setting('tagging_server_url');
        try {
            $request = $this->pinned($url);
        } catch (InvalidArgumentException) {
            return DeliveryResult::fail(DeliveryResult::BLOCKED);
        }
        $body = self::measurementProtocolBody((string) $event->provider_event_name, $event->event_id, $payload);
        try {
            $response = $request->post('/mp/collect?'.http_build_query(['measurement_id' => (string) $integration->setting('measurement_id')]), $body);
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('gtm_server', 'collect', $response->status(), ['integration_id' => $integration->id]);

        return $response->successful() ? DeliveryResult::ok($response->status()) : self::byStatus($response, self::redact($response->body(), []));
    }

    public function check(StoreIntegration $integration): DeliveryResult
    {
        try {
            $request = $this->pinned((string) $integration->setting('tagging_server_url'));
        } catch (InvalidArgumentException) {
            return DeliveryResult::fail(DeliveryResult::BLOCKED);
        }
        try {
            $response = $request->get('/healthy');
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('gtm_server', 'healthy', $response->status(), ['integration_id' => $integration->id]);

        return $response->status() === 200 ? DeliveryResult::ok(200) : DeliveryResult::fail(DeliveryResult::UNAVAILABLE, $response->status());
    }

    /** @throws InvalidArgumentException */
    private function pinned(string $url): PendingRequest
    {
        $pin = $this->guard->pin($url);

        return $this->http($url)->withOptions(['curl' => [CURLOPT_RESOLVE => $pin]]);
    }
}
