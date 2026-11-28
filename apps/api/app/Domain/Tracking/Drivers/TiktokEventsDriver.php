<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Http\Client\Response;
use Throwable;

/**
 * TikTok Events API (PHASE-8-9D §5.2): POST business-api.tiktok.com/open_api/{version}/event/track/ with the
 * `Access-Token` header, `event_source web`, hashed email / phone (E.164) / external_id, ttclid, ttp, IP, UA. Response
 * `code` 0 = accepted; 40001 / 40100 / 40104 / 40105 → `auth`, 40016 / 51xxx → rate limited / unavailable (VERIFY).
 */
final class TiktokEventsDriver extends HttpTrackingDriver
{
    private const AUTH_CODES = [40001, 40100, 40104, 40105];

    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult
    {
        $token = (string) ($integration->secrets()['access_token'] ?? '');
        $user = (array) ($payload['user'] ?? []);
        $client = (array) ($payload['client'] ?? []);
        $items = (array) ($payload['items'] ?? []);
        $body = array_filter([
            'event_source' => 'web',
            'event_source_id' => (string) $integration->setting('pixel_id'),
            'test_event_code' => $testCode,
            'data' => [array_filter([
                'event' => $event->provider_event_name,
                'event_time' => (int) ($payload['event_time'] ?? now()->getTimestamp()),
                'event_id' => $event->event_id,
                'user' => array_filter([
                    'email' => $user['em'] ?? null, 'phone' => $user['ph'] ?? null, 'external_id' => $user['external_id'] ?? null,
                    'ttclid' => $client['ttclid'] ?? null, 'ttp' => $client['ttp'] ?? null, 'ip' => $client['ip'] ?? null, 'user_agent' => $client['ua'] ?? null,
                ], fn ($v) => $v !== null),
                'page' => isset($payload['event_source_url']) ? ['url' => $payload['event_source_url']] : null,
                'properties' => array_filter([
                    'value' => self::decimal($payload['value_amount'] ?? null),
                    'currency' => $payload['currency'] ?? null,
                    'order_id' => $payload['transaction_id'] ?? null,
                    'content_type' => $items !== [] ? 'product' : null,
                    'contents' => $items !== [] ? array_values(array_map(fn (array $i) => array_filter(['content_id' => $i['id'], 'content_name' => $i['name'] ?? null,
                        'quantity' => $i['quantity'] ?? 1, 'price' => self::decimal($i['price_amount'] ?? null)], fn ($v) => $v !== null), $items)) : null,
                ], fn ($v) => $v !== null),
            ], fn ($v) => $v !== null && $v !== [])],
        ], fn ($v) => $v !== null);

        return $this->post($integration, '/event/track/', $body, $token);
    }

    /** Format-only plus a no-op call is not offered by TikTok (VERIFY): the token is checked by an empty batch. */
    public function check(StoreIntegration $integration): DeliveryResult
    {
        $token = (string) ($integration->secrets()['access_token'] ?? '');
        if ($token === '') {
            return DeliveryResult::fail(DeliveryResult::AUTH);
        }

        return $this->post($integration, '/event/track/', ['event_source' => 'web', 'event_source_id' => (string) $integration->setting('pixel_id'), 'data' => []], $token, true);
    }

    /** @param array<string, mixed> $body */
    private function post(StoreIntegration $integration, string $path, array $body, string $token, bool $check = false): DeliveryResult
    {
        try {
            $response = $this->http((string) config('tracking.tiktok.base_url'))->withHeaders(['Access-Token' => $token])
                ->post('/open_api/'.config('tracking.tiktok.version').$path, $body);
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('tiktok_events', $check ? 'check' : 'track', $response->status(), ['integration_id' => $integration->id]);

        return $this->map($response, [$token], $check);
    }

    /** @param list<string> $secrets */
    private function map(Response $response, array $secrets, bool $check): DeliveryResult
    {
        $message = self::redact(is_string($response->json('message')) ? $response->json('message') : null, $secrets);
        if (! $response->successful()) {
            return self::byStatus($response, $message);
        }
        $code = (int) $response->json('code', 0);

        return match (true) {
            $code === 0 => DeliveryResult::ok($response->status()),
            in_array($code, self::AUTH_CODES, true) => DeliveryResult::fail(DeliveryResult::AUTH, $response->status(), $message),
            $code === 40016 => DeliveryResult::fail(DeliveryResult::RATE_LIMITED, $response->status(), $message, 60),
            $code >= 50000 => DeliveryResult::fail(DeliveryResult::UNAVAILABLE, $response->status(), $message),
            // an empty check batch may be refused as invalid data while the token itself was accepted
            $check => DeliveryResult::ok($response->status()),
            default => DeliveryResult::fail(DeliveryResult::REJECTED, $response->status(), $message),
        };
    }
}
