<?php

namespace App\Domain\Stores\Services;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Request;

/** The store behind a storefront request (validated host), the preview flag and the shopper's IP. */
final class StorefrontContext
{
    public const CLIENT_IP_HEADER = 'X-Storefront-Client-Ip';

    public function __construct(
        public readonly Store $store,
        public readonly bool $preview,
        public readonly string $clientIp,
    ) {}

    public static function from(Request $request): self
    {
        /** @var ResolvedStorefront $resolved */
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);
        $store = Store::query()->with('settings')->findOrFail($resolved->storeId);

        return new self($store, (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false), self::clientIp($request));
    }

    /** Draft stores are "Coming soon" for the public (P5-24); preview sees everything. */
    public function requireVisible(): self
    {
        if ($this->store->status !== Store::STATUS_ACTIVE && ! $this->preview) {
            throw new ApiException(404, 'store_not_found', 'No store is registered for this host.');
        }

        return $this;
    }

    public function isLive(): bool
    {
        return $this->store->status === Store::STATUS_ACTIVE;
    }

    /**
     * Shopper IP: X-Storefront-Client-Ip is trusted only together with a valid storefront key (server-to-server).
     * Throttles run before the key middleware, so the key is checked here as well.
     */
    public static function clientIp(Request $request): string
    {
        return self::trustedClientIp($request) ?? (string) $request->ip();
    }

    /** True when the request carries the storefront server key (constant-time compare). */
    public static function hasValidKey(Request $request): bool
    {
        $expected = (string) config('storeplix.storefront_api_key');
        $given = (string) $request->header(ResolveStorefront::KEY_HEADER, '');

        return $expected !== '' && $given !== '' && hash_equals($expected, $given);
    }

    /** The forwarded shopper IP when the storefront key is valid and the header holds an IP; null otherwise. */
    public static function trustedClientIp(Request $request): ?string
    {
        $header = trim((string) $request->header(self::CLIENT_IP_HEADER, ''));
        if (self::hasValidKey($request) && filter_var($header, FILTER_VALIDATE_IP) !== false) {
            return $header;
        }

        return null;
    }

    /**
     * Rate-limit key for a shopper IP (P5B-9): the IPv4 address, or the /64 prefix of an IPv6 address (one
     * subscriber line usually owns a whole /64, so per-address keys would be trivial to rotate).
     */
    public static function ipKey(string $ip): string
    {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            return $ip;
        }

        $packed = inet_pton($ip);
        if ($packed === false) {
            return $ip;
        }

        // IPv4-mapped (::ffff:a.b.c.d): key by the IPv4 address, not by the shared ::/64.
        if (str_starts_with($packed, str_repeat("\0", 10)."\xff\xff")) {
            return (string) inet_ntop(substr($packed, 12));
        }

        return inet_ntop(substr($packed, 0, 8).str_repeat("\0", 8)).'/64';
    }
}
