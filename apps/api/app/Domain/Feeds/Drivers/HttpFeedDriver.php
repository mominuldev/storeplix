<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\SafeHttpClient;
use App\Domain\Shared\Support\Money;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/** Shared plumbing for the feed drivers (P89D-17): fixed https hosts, 10 s / 30 s, no redirects, status-only logs. */
abstract class HttpFeedDriver implements FeedDriver
{
    protected function http(string $baseUrl): PendingRequest
    {
        SafeHttpClient::assertSafeBaseUrl($baseUrl);

        return Http::baseUrl(rtrim($baseUrl, '/'))->connectTimeout(10)->timeout(30)->withoutRedirecting()->acceptJson();
    }

    protected function token(StoreIntegration $integration): string
    {
        $token = $integration->secrets()['access_token'] ?? null;

        return is_string($token) && $token !== '' ? $token : throw new FeedException(FeedException::AUTH, 'No access token.');
    }

    /** @param callable(): Response $call */
    protected function call(string $provider, string $action, callable $call, ?string $step = null): Response
    {
        try {
            $response = $call();
        } catch (Throwable) {
            throw new FeedException(FeedException::UNAVAILABLE, 'The provider did not answer.', $step);
        }
        SafeHttpClient::log($provider, $action, $response->status());
        if ($response->successful()) {
            return $response;
        }
        $status = $response->status();

        throw new FeedException(match (true) {
            $status === 401 || $status === 403 => FeedException::AUTH,
            $status === 429 => FeedException::RATE_LIMITED,
            $status >= 500 => FeedException::UNAVAILABLE,
            default => FeedException::REJECTED,
        }, "HTTP {$status}", $step);
    }

    protected static function price(int $amount, string $currency): string
    {
        return Money::toDecimal($amount).' '.$currency;
    }

    /** Provider text is data: tags stripped, ≤ 300 chars (escaped again by every renderer). */
    protected static function text(mixed $value): string
    {
        return Str::limit(trim(strip_tags(is_scalar($value) ? (string) $value : '')), (int) config('feeds.issue_message_max', 300), '…');
    }
}
