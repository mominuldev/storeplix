<?php

declare(strict_types=1);

namespace App\Domain\Domains\Dns;

use App\Domain\Integrations\SafeHttpClient;
use GuzzleHttp\Promise\PromiseInterface;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * DNS over HTTPS, JSON API (§5.1; Cloudflare `dns-query` and Google `resolve`). The endpoint comes from config only;
 * https, no redirects, a short timeout, no retries inside a check. Status 0 → answer, 3 → NXDOMAIN, anything else
 * (SERVFAIL, non-2xx, timeout, unparsable body) → error (the check is inconclusive).
 */
final class DohResolver implements DnsResolver
{
    public function __construct(
        private readonly string $resolverName,
        private readonly string $endpoint,
        private readonly int $timeout = 3,
    ) {
        SafeHttpClient::assertSafeBaseUrl($endpoint);
    }

    public function name(): string
    {
        return $this->resolverName;
    }

    public function query(string $name, string $type): DnsAnswer
    {
        try {
            return $this->parse($this->send(Http::createPendingRequest(), $name, $type));
        } catch (Throwable) {
            return DnsAnswer::error();
        }
    }

    /** Configures $request (plain or a Pool slot) and sends the question. */
    public function send(PendingRequest $request, string $name, string $type): Response|PromiseInterface
    {
        $parts = parse_url($this->endpoint);
        $base = $parts['scheme'].'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');

        return $request->baseUrl($base)
            ->connectTimeout($this->timeout)
            ->timeout($this->timeout)
            ->withoutRedirecting()
            ->accept('application/dns-json')
            ->get($parts['path'] ?? '/', ['name' => $name, 'type' => $type]);
    }

    public function parse(mixed $response): DnsAnswer
    {
        if (! $response instanceof Response || ! $response->successful()) {
            return DnsAnswer::error();
        }
        $body = $response->json();
        if (! is_array($body) || ! isset($body['Status']) || ! is_int($body['Status'])) {
            return DnsAnswer::error();
        }

        return match ($body['Status']) {
            0 => DnsAnswer::ok(array_values(array_map(
                fn ($r) => ['type' => (int) ($r['type'] ?? 0), 'data' => (string) ($r['data'] ?? '')],
                array_filter((array) ($body['Answer'] ?? []), 'is_array'),
            ))),
            3 => DnsAnswer::nxdomain(),
            default => DnsAnswer::error(),
        };
    }
}
