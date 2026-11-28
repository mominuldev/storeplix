<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Http\Client\Response;
use Throwable;

/**
 * Meta Conversions API (PHASE-8-9D §5.2): POST graph.facebook.com/{version}/{pixel_id}/events, `action_source website`,
 * hashed `user_data` + client IP / UA / fbp / fbc, `event_id` for dedupe with the browser pixel. Field names VERIFY.
 * Graph error 190 (invalid token) or HTTP 401/403 → `auth`; codes 4 / 17 / 32 / 613 → `rate_limited`.
 */
final class MetaCapiDriver extends HttpTrackingDriver
{
    public function send(StoreIntegration $integration, TrackingEvent $event, array $payload, ?string $testCode = null, bool $debug = false): DeliveryResult
    {
        $token = (string) ($integration->secrets()['access_token'] ?? '');
        $user = (array) ($payload['user'] ?? []);
        $client = (array) ($payload['client'] ?? []);
        $items = (array) ($payload['items'] ?? []);
        $data = array_filter([
            'event_name' => $event->provider_event_name,
            'event_time' => (int) ($payload['event_time'] ?? now()->getTimestamp()),
            'event_id' => $event->event_id,
            'event_source_url' => $payload['event_source_url'] ?? null,
            'action_source' => 'website',
            'user_data' => array_filter([
                'em' => isset($user['em']) ? [$user['em']] : null,
                'ph' => isset($user['ph_meta']) ? [$user['ph_meta']] : null,
                'fn' => isset($user['fn']) ? [$user['fn']] : null,
                'ln' => isset($user['ln']) ? [$user['ln']] : null,
                'ct' => isset($user['ct']) ? [$user['ct']] : null,
                'country' => isset($user['country']) ? [$user['country']] : null,
                'external_id' => isset($user['external_id']) ? [$user['external_id']] : null,
                'client_ip_address' => $client['ip'] ?? null,
                'client_user_agent' => $client['ua'] ?? null,
                'fbp' => $client['fbp'] ?? null,
                'fbc' => $client['fbc'] ?? null,
            ], fn ($v) => $v !== null),
            'custom_data' => array_filter([
                'value' => self::decimal($payload['value_amount'] ?? null),
                'currency' => $payload['currency'] ?? null,
                'order_id' => $payload['transaction_id'] ?? null,
                'content_type' => $items !== [] ? 'product' : null,
                'content_ids' => $items !== [] ? array_values(array_map(fn (array $i) => $i['id'], $items)) : null,
                'contents' => $items !== [] ? array_values(array_map(fn (array $i) => ['id' => $i['id'], 'quantity' => $i['quantity'] ?? 1, 'item_price' => self::decimal($i['price_amount'] ?? null)], $items)) : null,
            ], fn ($v) => $v !== null),
        ], fn ($v) => $v !== null && $v !== []);
        $body = array_filter(['data' => [$data], 'test_event_code' => $testCode, 'access_token' => $token], fn ($v) => $v !== null);

        try {
            $response = $this->http((string) config('tracking.meta.base_url'))
                ->post('/'.config('tracking.meta.version').'/'.rawurlencode((string) $integration->setting('pixel_id')).'/events', $body);
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('meta_capi', 'events', $response->status(), ['integration_id' => $integration->id]);

        return $this->map($response, [$token]);
    }

    public function check(StoreIntegration $integration): DeliveryResult
    {
        $token = (string) ($integration->secrets()['access_token'] ?? '');
        if ($token === '') {
            return DeliveryResult::fail(DeliveryResult::AUTH);
        }
        try {
            $response = $this->http((string) config('tracking.meta.base_url'))
                ->get('/'.config('tracking.meta.version').'/'.rawurlencode((string) $integration->setting('pixel_id')), ['fields' => 'name', 'access_token' => $token]);
        } catch (Throwable $e) {
            return self::fromException($e);
        }
        SafeHttpClient::log('meta_capi', 'check', $response->status(), ['integration_id' => $integration->id]);
        $result = $this->map($response, [$token]);
        $name = $response->json('name');

        return $result->delivered ? DeliveryResult::ok($response->status(), is_string($name) ? mb_substr(strip_tags($name), 0, 120) : null) : $result;
    }

    /** @param list<string> $secrets */
    private function map(Response $response, array $secrets): DeliveryResult
    {
        if ($response->successful()) {
            return DeliveryResult::ok($response->status());
        }
        $code = (int) $response->json('error.code', 0);
        $message = self::redact(is_string($response->json('error.message')) ? $response->json('error.message') : null, $secrets);
        if ($code === 190 || $response->status() === 401 || $response->status() === 403) {
            return DeliveryResult::fail(DeliveryResult::AUTH, $response->status(), $message);
        }
        if (in_array($code, [4, 17, 32, 613], true)) {
            return DeliveryResult::fail(DeliveryResult::RATE_LIMITED, $response->status(), $message, self::retryAfter($response));
        }

        return self::byStatus($response, $message);
    }
}
