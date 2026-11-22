<?php

declare(strict_types=1);

namespace App\Domain\Domains\Providers;

use App\Domain\Integrations\SafeHttpClient;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Cloudflare for SaaS custom hostnames API v4 (§5.2). Base URL, token and zone from config only; https, no redirects,
 * 10 s connect / 20 s total. Logs carry the action, ids and HTTP status only, never the token or bodies.
 * Every "VERIFY against staging" detail lives in one method: duplicateError(), the create payload, the status maps.
 */
final class CloudflareCustomHostnames implements CustomHostnameProvider
{
    /** VERIFY: Cloudflare's "Duplicate custom hostname found." error code. */
    public const DUPLICATE_CODES = [1406];

    public function name(): string
    {
        return 'cloudflare';
    }

    public function create(string $hostname): ProviderHostname
    {
        $response = $this->call('create', fn (PendingRequest $r) => $r->post($this->zonePath(), [
            'hostname' => $hostname,
            'ssl' => ['method' => 'http', 'type' => 'dv', 'settings' => ['min_tls_version' => '1.2']], // VERIFY
        ]), allowDuplicate: true);

        return self::hostname((array) $response->json('result'));
    }

    public function findByHostname(string $hostname): ?ProviderHostname
    {
        $response = $this->call('find', fn (PendingRequest $r) => $r->get($this->zonePath(), ['hostname' => $hostname]));
        foreach ((array) $response->json('result') as $row) {
            if (is_array($row) && strtolower((string) ($row['hostname'] ?? '')) === $hostname) {
                return self::hostname($row);
            }
        }

        return null;
    }

    public function get(string $id): ?ProviderHostname
    {
        $response = $this->call('get', fn (PendingRequest $r) => $r->get($this->zonePath().'/'.rawurlencode($id)), allowNotFound: true);

        return $response->status() === 404 ? null : self::hostname((array) $response->json('result'));
    }

    public function delete(string $id): void
    {
        $this->call('delete', fn (PendingRequest $r) => $r->delete($this->zonePath().'/'.rawurlencode($id)), allowNotFound: true);
    }

    public function list(int $page): array
    {
        $response = $this->call('list', fn (PendingRequest $r) => $r->get($this->zonePath(), ['page' => max(1, $page), 'per_page' => 50]));
        $items = [];
        foreach ((array) $response->json('result') as $row) {
            if (is_array($row)) {
                $items[] = self::hostname($row);
            }
        }
        $totalPages = (int) ($response->json('result_info.total_pages') ?? 1);

        return ['items' => $items, 'has_more' => $page < $totalPages];
    }

    /** @param array<string, mixed> $row */
    public static function hostname(array $row): ProviderHostname
    {
        return new ProviderHostname(
            (string) ($row['id'] ?? ''),
            strtolower((string) ($row['hostname'] ?? '')),
            (string) ($row['status'] ?? 'pending'),
            isset($row['ssl']['status']) ? (string) $row['ssl']['status'] : null,
            isset($row['created_at']) ? (string) $row['created_at'] : null,
        );
    }

    /** VERIFY: a duplicate hostname is reported as an error code in the v4 envelope. */
    public static function duplicateError(Response $response): bool
    {
        foreach ((array) $response->json('errors') as $error) {
            if (is_array($error) && (in_array((int) ($error['code'] ?? 0), self::DUPLICATE_CODES, true)
                || str_contains(strtolower((string) ($error['message'] ?? '')), 'duplicate'))) {
                return true;
            }
        }

        return false;
    }

    /** @param callable(PendingRequest): Response $send */
    private function call(string $action, callable $send, bool $allowNotFound = false, bool $allowDuplicate = false): Response
    {
        $base = (string) config('domains.cloudflare.api_base');
        $token = (string) config('domains.cloudflare.api_token');
        if ($token === '' || (string) config('domains.cloudflare.zone_id') === '') {
            Log::error('domains.provider_not_configured', ['provider' => 'cloudflare', 'action' => $action]);

            throw new ProviderException(ProviderException::AUTH, 'The certificate provider is not configured.');
        }
        try {
            SafeHttpClient::assertSafeBaseUrl($base);
            $request = Http::baseUrl(rtrim($base, '/'))
                ->connectTimeout((int) config('domains.cloudflare.connect_timeout', 10))
                ->timeout((int) config('domains.cloudflare.timeout', 20))
                ->withoutRedirecting()
                ->acceptJson()
                ->withToken($token);
            $response = $send($request);
        } catch (Throwable) {
            SafeHttpClient::log('cloudflare', 'custom_hostnames.'.$action, null);

            throw new ProviderException(ProviderException::ERROR, 'The certificate provider did not answer.');
        }
        SafeHttpClient::log('cloudflare', 'custom_hostnames.'.$action, $response->status());

        if ($response->successful() && $response->json('success') !== false) {
            return $response;
        }
        if ($allowNotFound && $response->status() === 404) {
            return $response;
        }
        if ($allowDuplicate && self::duplicateError($response)) {
            throw new ProviderException(ProviderException::DUPLICATE, 'The hostname already exists at the provider.', $response->status());
        }
        if (in_array($response->status(), [401, 403], true)) {
            Log::error('domains.provider_auth_failed', ['provider' => 'cloudflare', 'action' => $action, 'status' => $response->status()]);

            throw new ProviderException(ProviderException::AUTH, 'The certificate provider refused our credentials.', $response->status());
        }

        throw new ProviderException(ProviderException::ERROR, 'The certificate provider returned an error.', $response->status());
    }

    private function zonePath(): string
    {
        return '/zones/'.rawurlencode((string) config('domains.cloudflare.zone_id')).'/custom_hostnames';
    }
}
