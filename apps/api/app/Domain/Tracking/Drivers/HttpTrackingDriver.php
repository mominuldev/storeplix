<?php

declare(strict_types=1);

namespace App\Domain\Tracking\Drivers;

use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Shared\Support\Money;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/**
 * Shared plumbing for the provider drivers (P89D-17): fixed https hosts from config, 5 s connect / 10 s total, no
 * redirects, no retries; log lines carry provider, action and HTTP status only. Provider text is redacted (every secret
 * of the integration replaced by ••••) and cut to 200 chars.
 */
abstract class HttpTrackingDriver implements TrackingDriver
{
    protected function http(string $baseUrl): PendingRequest
    {
        SafeHttpClient::assertSafeBaseUrl($baseUrl);

        return Http::baseUrl(rtrim($baseUrl, '/'))
            ->connectTimeout((int) config('tracking.http.connect_timeout', 5))
            ->timeout((int) config('tracking.http.timeout', 10))
            ->withoutRedirecting()
            ->acceptJson();
    }

    /** @param list<string|null> $secrets */
    protected static function redact(?string $text, array $secrets): ?string
    {
        if ($text === null || trim($text) === '') {
            return null;
        }
        foreach ($secrets as $secret) {
            if (is_string($secret) && $secret !== '') {
                $text = str_replace($secret, '••••', $text);
            }
        }
        $text = preg_replace('/(access_token|api_secret|token)=[^&\s"]+/i', '$1=••••', $text) ?? $text;

        return Str::limit(trim(strip_tags($text)), 200, '…');
    }

    protected static function fromException(Throwable $e): DeliveryResult
    {
        if ($e instanceof ConnectionException && str_contains($e->getMessage(), 'timed out')) {
            return DeliveryResult::fail(DeliveryResult::TIMEOUT);
        }

        return DeliveryResult::fail(DeliveryResult::UNAVAILABLE);
    }

    /** Generic HTTP status mapping (401/403 auth, 429 rate limited, 5xx unavailable, other 4xx rejected). */
    protected static function byStatus(Response $response, ?string $message): DeliveryResult
    {
        $status = $response->status();

        return match (true) {
            $status === 401 || $status === 403 => DeliveryResult::fail(DeliveryResult::AUTH, $status, $message),
            $status === 429 => DeliveryResult::fail(DeliveryResult::RATE_LIMITED, $status, $message, self::retryAfter($response)),
            $status >= 500 => DeliveryResult::fail(DeliveryResult::UNAVAILABLE, $status, $message),
            default => DeliveryResult::fail(DeliveryResult::REJECTED, $status, $message),
        };
    }

    protected static function retryAfter(Response $response): ?int
    {
        $value = $response->header('Retry-After');

        return is_numeric($value) ? min((int) $value, (int) config('tracking.max_retry_after', 3600)) : null;
    }

    /** P89D-21: minor units → a decimal number for the tracker (2 places). */
    protected static function decimal(?int $amount): ?float
    {
        return $amount === null ? null : (float) Money::toDecimal($amount);
    }

    /**
     * GA4 Measurement Protocol body (GA4 and the GTM server container). Hashed user data per Google's user-provided data
     * format (VERIFY): sha256_email_address, sha256_phone_number (E.164), address sha256_first_name / last_name / city.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    protected static function measurementProtocolBody(string $eventName, string $eventId, array $payload): array
    {
        $client = (array) ($payload['client'] ?? []);
        $user = (array) ($payload['user'] ?? []);
        $params = array_filter([
            'transaction_id' => $payload['transaction_id'] ?? null,
            'value' => self::decimal($payload['value_amount'] ?? null),
            'currency' => $payload['currency'] ?? null,
            'items' => array_map(fn (array $i) => array_filter([
                'item_id' => $i['id'], 'item_name' => $i['name'] ?? null, 'quantity' => $i['quantity'] ?? 1, 'price' => self::decimal($i['price_amount'] ?? null),
            ], fn ($v) => $v !== null), (array) ($payload['items'] ?? [])) ?: null,
            'session_id' => $client['ga_session_id'] ?? null,
            'page_location' => $payload['event_source_url'] ?? null,
            'event_id' => $eventId,
            'engagement_time_msec' => 1,
        ], fn ($v) => $v !== null);
        $address = array_filter([
            'sha256_first_name' => $user['fn'] ?? null, 'sha256_last_name' => $user['ln'] ?? null, 'sha256_city' => $user['ct'] ?? null, 'country' => isset($user['country']) ? 'BD' : null,
        ], fn ($v) => $v !== null);
        $userData = array_filter([
            'sha256_email_address' => isset($user['em']) ? [$user['em']] : null,
            'sha256_phone_number' => isset($user['ph']) ? [$user['ph']] : null,
            'address' => $address !== [] && count($address) > 1 ? [$address] : null,
        ], fn ($v) => $v !== null);

        return array_filter([
            'client_id' => (string) ($client['ga_client_id'] ?? $payload['client_id'] ?? $eventId),
            'timestamp_micros' => isset($payload['event_time']) ? (int) $payload['event_time'] * 1_000_000 : null,
            'user_data' => $userData !== [] ? $userData : null,
            'events' => [['name' => $eventName, 'params' => $params]],
        ], fn ($v) => $v !== null);
    }
}
