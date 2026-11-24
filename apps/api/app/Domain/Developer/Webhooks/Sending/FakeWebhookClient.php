<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks\Sending;

use App\Domain\Tenancy\Support\TenantCache;

/**
 * WEBHOOKS_OUT_FAKE (local / e2e; refused in production, S112): no network. Each request is recorded in the tenant's
 * dev sink (GET /api/v1/dev/webhook-sink) and answered by URL path suffix: `/fail-503` → 503, `/timeout` → timeout,
 * anything else → 200. Save/send URL rules still apply, without the DNS lookup.
 */
final class FakeWebhookClient implements WebhookSender
{
    public const SINK_KEY = 'webhooks:dev-sink';

    public function __construct(
        private readonly WebhookUrlGuard $guard,
        private readonly TenantCache $cache,
    ) {}

    public function send(string $url, array $headers, string $body): SendResult
    {
        try {
            $this->guard->check($url, false);
        } catch (UrlNotAllowed) {
            return SendResult::error('url_not_allowed', 0);
        }
        $path = rtrim((string) parse_url($url, PHP_URL_PATH), '/');
        $result = match (true) {
            str_ends_with($path, '/fail-503') => SendResult::response(503, '{"error":"fake 503"}', 12),
            str_ends_with($path, '/timeout') => SendResult::error('timeout', (int) config('webhooks_out.timeout', 10) * 1000),
            default => SendResult::response(200, '{"ok":true}', 8),
        };
        $this->record($url, $headers, $body, $result);

        return $result;
    }

    /** @return list<array<string, mixed>> newest first */
    public function sink(): array
    {
        return (array) $this->cache->get(self::SINK_KEY, []);
    }

    /** @param array<string, string> $headers */
    private function record(string $url, array $headers, string $body, SendResult $result): void
    {
        $entries = $this->sink();
        array_unshift($entries, [
            'url' => $url,
            'headers' => $headers,
            'raw_body' => $body,
            'response_status' => $result->status,
            'error_code' => $result->errorCode,
            'received_at' => now()->toIso8601ZuluString(),
        ]);
        $this->cache->put(self::SINK_KEY, array_slice($entries, 0, (int) config('webhooks_out.sink_size', 50)), 86400);
    }
}
