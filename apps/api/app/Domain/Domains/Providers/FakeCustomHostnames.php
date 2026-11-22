<?php

declare(strict_types=1);

namespace App\Domain\Domains\Providers;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

/**
 * DOMAINS_FAKE (§5.3): custom hostnames kept in the cache, ids `fake_{ulid}`. Lifecycle: `pending` until the
 * (DOMAINS_FAKE_SSL_POLLS + 1)-th `get`, then `active`/`active`; hostnames starting with `fail-ssl.` end with SSL
 * `validation_timed_out`. `POST /dev/domains/{id}/provider` pins a state (override by hostname, also before create).
 */
final class FakeCustomHostnames implements CustomHostnameProvider
{
    private const PREFIX = 'fake-provider';

    public function name(): string
    {
        return 'fake';
    }

    public function create(string $hostname): ProviderHostname
    {
        if ($this->idFor($hostname) !== null) {
            throw new ProviderException(ProviderException::DUPLICATE, 'The hostname already exists at the provider.', 409);
        }
        $id = 'fake_'.strtolower((string) Str::ulid());
        $row = ['id' => $id, 'hostname' => $hostname, 'status' => 'pending', 'ssl' => 'initializing', 'polls' => 0, 'created_at' => now()->toIso8601ZuluString()];
        Cache::forever(self::PREFIX.':'.$id, $row);
        Cache::forever(self::PREFIX.':host:'.$hostname, $id);
        $ids = (array) Cache::get(self::PREFIX.':ids', []);
        $ids[] = $id;
        Cache::forever(self::PREFIX.':ids', array_values(array_unique($ids)));

        return $this->present($row);
    }

    public function findByHostname(string $hostname): ?ProviderHostname
    {
        $id = $this->idFor($hostname);

        return $id === null ? null : $this->peek($id);
    }

    public function get(string $id): ?ProviderHostname
    {
        $row = Cache::get(self::PREFIX.':'.$id);
        if (! is_array($row)) {
            return null;
        }
        $row['polls'] = (int) $row['polls'] + 1;
        $override = Cache::get(self::PREFIX.':override:'.$row['hostname']);
        if (is_array($override)) {
            $row['status'] = $override['status'];
            $row['ssl'] = $override['ssl'];
        } elseif ($row['polls'] > max(0, (int) config('domains.fake_ssl_polls', 1))) {
            $row['status'] = 'active';
            $row['ssl'] = str_starts_with($row['hostname'], 'fail-ssl.') ? 'validation_timed_out' : 'active';
        }
        Cache::forever(self::PREFIX.':'.$id, $row);

        return $this->present($row);
    }

    public function delete(string $id): void
    {
        $row = Cache::get(self::PREFIX.':'.$id);
        if (is_array($row)) {
            Cache::forget(self::PREFIX.':host:'.$row['hostname']);
        }
        Cache::forget(self::PREFIX.':'.$id);
        Cache::forever(self::PREFIX.':ids', array_values(array_diff((array) Cache::get(self::PREFIX.':ids', []), [$id])));
    }

    public function list(int $page): array
    {
        $ids = array_slice((array) Cache::get(self::PREFIX.':ids', []), (max(1, $page) - 1) * 50, 50);
        $items = array_values(array_filter(array_map(fn ($id) => $this->peek((string) $id), $ids)));

        return ['items' => $items, 'has_more' => count((array) Cache::get(self::PREFIX.':ids', [])) > $page * 50];
    }

    /**
     * Pins the provider state of a hostname (dev route / tests). Raw Cloudflare values.
     */
    public static function override(string $hostname, string $status, string $ssl): void
    {
        Cache::forever(self::PREFIX.':override:'.$hostname, ['status' => $status, 'ssl' => $ssl]);
    }

    /** Test helper: backdates a fake hostname's created_at (reconcile ignores hostnames younger than 1 h). */
    public static function backdate(string $id, int $hours): void
    {
        $row = Cache::get(self::PREFIX.':'.$id);
        if (is_array($row)) {
            $row['created_at'] = now()->subHours($hours)->toIso8601ZuluString();
            Cache::forever(self::PREFIX.':'.$id, $row);
        }
    }

    private function idFor(string $hostname): ?string
    {
        $id = Cache::get(self::PREFIX.':host:'.$hostname);

        return is_string($id) && Cache::has(self::PREFIX.':'.$id) ? $id : null;
    }

    private function peek(string $id): ?ProviderHostname
    {
        $row = Cache::get(self::PREFIX.':'.$id);

        return is_array($row) ? $this->present($row) : null;
    }

    /** @param array<string, mixed> $row */
    private function present(array $row): ProviderHostname
    {
        return new ProviderHostname((string) $row['id'], (string) $row['hostname'], (string) $row['status'], (string) $row['ssl'], (string) ($row['created_at'] ?? ''));
    }
}
