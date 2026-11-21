<?php

namespace App\Domain\Stores\Http\Middleware;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Preview\PreviewTokenService;
use App\Domain\Stores\Services\ResolvedStorefront;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware "storefront" for the public storefront API (server-to-server only).
 *
 * 1. X-Storefront-Key must equal STOREFRONT_API_KEY (constant-time compare; fails closed if unset).
 * 2. The tenant is resolved ONLY from X-Storefront-Host, validated against registered active
 *    store_domains. Host / X-Forwarded-Host are deliberately ignored.
 */
class ResolveStorefront
{
    public const KEY_HEADER = 'X-Storefront-Key';

    public const HOST_HEADER = 'X-Storefront-Host';

    public const PREVIEW_HEADER = 'X-Storefront-Preview';

    public const ATTRIBUTE = 'storefront';

    public const PREVIEW_ATTRIBUTE = 'storefront_preview';

    public function __construct(
        private readonly StorefrontResolver $resolver,
        private readonly TenantContext $context,
        private readonly PreviewTokenService $previews,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $expected = (string) config('storeplix.storefront_api_key');
        $given = (string) $request->header(self::KEY_HEADER, '');

        if ($expected === '' || $given === '' || ! hash_equals($expected, $given)) {
            throw new ApiException(401, 'invalid_storefront_key', 'Missing or invalid storefront key.');
        }

        $host = (string) $request->header(self::HOST_HEADER, '');

        if (trim($host) === '') {
            throw new ApiException(400, 'storefront_host_required', 'The X-Storefront-Host header is required.');
        }

        $resolved = $this->resolver->resolve($host);

        if (! $resolved instanceof ResolvedStorefront) {
            throw new ApiException(404, 'store_not_found', 'No store is registered for this host.');
        }

        // D2: a preview token only counts when it is valid for THIS resolved store. Invalid/expired
        // tokens silently degrade to a public visitor (no error leak). The host cache only ever holds
        // {tenant_id, store_id}; preview state is computed per request and never cached.
        $preview = $this->previews->isValidFor($request->header(self::PREVIEW_HEADER), $resolved->storeId);

        $request->attributes->set(self::ATTRIBUTE, $resolved);
        $request->attributes->set(self::PREVIEW_ATTRIBUTE, $preview);
        $this->context->set($resolved->tenantId);

        try {
            $response = $next($request);

            if ($preview) {
                $response->headers->set('Cache-Control', 'private, no-store');
                $response->headers->set('Vary', 'X-Storefront-Preview', false);
            }

            return $response;
        } finally {
            $this->context->clear();
        }
    }
}
