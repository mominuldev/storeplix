<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * The real sender (§4.3, P84-10, S107). The URL is re-checked right before the request; the connection is pinned to
 * the checked IP with CURLOPT_RESOLVE so a second DNS answer can't redirect it (no rebinding). No redirects, https
 * (or allowed http) only, 5 s connect / 10 s total. Bodies and headers are never logged.
 */
final class OutboundWebhookClient implements WebhookSender
{
    public function __construct(private readonly WebhookUrlGuard $guard) {}

    public function send(string $url, array $headers, string $body): SendResult
    {
        $start = hrtime(true);
        try {
            $target = $this->guard->check($url, true);
        } catch (UrlNotAllowed) {
            return SendResult::error('url_not_allowed', 0);
        }
        $ip = $target->ips[0];
        $pinned = sprintf('%s:%d:%s', $target->host, $target->port, str_contains($ip, ':') ? "[{$ip}]" : $ip);

        try {
            $response = Http::withOptions([
                'allow_redirects' => false,
                'curl' => [
                    CURLOPT_RESOLVE => [$pinned],
                    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | ($target->scheme === 'http' ? CURLPROTO_HTTP : 0),
                    CURLOPT_FOLLOWLOCATION => false,
                ],
            ])
                ->connectTimeout((int) config('webhooks_out.connect_timeout', 5))
                ->timeout((int) config('webhooks_out.timeout', 10))
                ->withHeaders($headers)
                ->withBody($body, 'application/json')
                ->post($url);

            return SendResult::response($response->status(), $response->body(), self::ms($start));
        } catch (ConnectionException $e) {
            $timeout = str_contains(strtolower($e->getMessage()), 'timed out') || str_contains($e->getMessage(), 'cURL error 28');

            return SendResult::error($timeout ? 'timeout' : 'connection_failed', self::ms($start));
        } catch (Throwable) {
            return SendResult::error('connection_failed', self::ms($start));
        }
    }

    private static function ms(int|float $start): int
    {
        return (int) round((hrtime(true) - $start) / 1_000_000);
    }
}
