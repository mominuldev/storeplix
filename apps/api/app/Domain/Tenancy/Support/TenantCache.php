<?php

namespace App\Domain\Tenancy\Support;

use App\Domain\Tenancy\TenantContext;
use Closure;
use DateInterval;
use DateTimeInterface;
use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Cache\Repository;

/**
 * Cache helper that prefixes every key with the current tenant ("tenant:{id}:{key}").
 * Throws when no tenant context is set, so tenant data can't land under a shared key.
 * Use the plain Cache facade only for deliberately tenant-neutral keys (e.g. "domain:{host}").
 */
class TenantCache
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly CacheFactory $cache,
    ) {}

    public function key(string $key): string
    {
        return 'tenant:'.$this->context->requireId().':'.$key;
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->store()->get($this->key($key), $default);
    }

    public function put(string $key, mixed $value, DateTimeInterface|DateInterval|int|null $ttl = null): bool
    {
        return $this->store()->put($this->key($key), $value, $ttl);
    }

    /** PHASE-8-7 P87-12: a value without expiry (e.g. the `expenses_rev` token keying the profit report cache). */
    public function forever(string $key, mixed $value): bool
    {
        return $this->store()->forever($this->key($key), $value);
    }

    public function remember(string $key, DateTimeInterface|DateInterval|int|null $ttl, Closure $callback): mixed
    {
        return $this->store()->remember($this->key($key), $ttl, $callback);
    }

    public function forget(string $key): bool
    {
        return $this->store()->forget($this->key($key));
    }

    private function store(): Repository
    {
        return $this->cache->store();
    }
}
