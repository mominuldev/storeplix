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
        $expected = (string) config('storeplix.storefront_api_key');
        $given = (string) $request->header(ResolveStorefront::KEY_HEADER, '');
        $header = trim((string) $request->header(self::CLIENT_IP_HEADER, ''));
        if ($expected !== '' && $given !== '' && hash_equals($expected, $given) && filter_var($header, FILTER_VALIDATE_IP) !== false) {
            return $header;
        }

        return (string) $request->ip();
    }
}
