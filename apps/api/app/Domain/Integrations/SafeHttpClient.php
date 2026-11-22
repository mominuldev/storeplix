<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use InvalidArgumentException;

/**
 * Outbound HTTP for integration drivers (SECURITY T14, PHASE-5B §3, S27). The base URL comes from config by
 * provider and mode, never from merchant input; it must be https and must not be an IP literal in a private,
 * loopback, link-local or metadata range. 10 s connect / 30 s total (config payments.http), no redirects, no retries.
 * Log lines carry the provider, action, ids and HTTP status only — never bodies, headers, tokens or credentials.
 */
final class SafeHttpClient
{
    public function to(string $baseUrl): PendingRequest
    {
        self::assertSafeBaseUrl($baseUrl);

        return Http::baseUrl(rtrim($baseUrl, '/'))
            ->connectTimeout((int) config('payments.http.connect_timeout', 10))
            ->timeout((int) config('payments.http.timeout', 30))
            ->withoutRedirecting()
            ->acceptJson();
    }

    /** @param array<string, scalar|null> $ids e.g. ['payment_id' => …, 'account_id' => …] */
    public static function log(string $provider, string $action, ?int $status, array $ids = []): void
    {
        Log::info('integration.http', ['provider' => $provider, 'action' => $action, 'status' => $status] + $ids);
    }

    public static function assertSafeBaseUrl(string $url): void
    {
        $parts = parse_url($url);
        $host = is_array($parts) ? ($parts['host'] ?? '') : '';
        if (! is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || $host === '' || isset($parts['user']) || isset($parts['pass'])) {
            throw new InvalidArgumentException('Integration base URLs must be plain https URLs.');
        }
        $ip = trim($host, '[]');
        if (filter_var($ip, FILTER_VALIDATE_IP) !== false
            && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            throw new InvalidArgumentException('Integration base URLs must not point at private or reserved addresses.');
        }
        if (in_array(strtolower($host), ['localhost', 'metadata.google.internal'], true)) {
            throw new InvalidArgumentException('Integration base URLs must not point at local hosts.');
        }
    }
}
