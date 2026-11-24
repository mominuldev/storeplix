<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Middleware;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Developer\ApiKeys\ApiKeyService;
use App\Domain\Developer\ApiKeys\ApiScope;
use App\Domain\Developer\ApiKeys\CurrentApiKey;
use App\Domain\Developer\ApiKeys\Models\ApiKey;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Authorization\PermissionSet;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PreTenantLookup;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;

/**
 * Route middleware `apikey` (PHASE-8-4 §3, P84-3/P84-4): authenticates the external API by
 * `Authorization: Bearer sp_live_…`. Never reads a session or X-Tenant-Id.
 *
 * Malformed, unknown and revoked keys all answer the same 401 `invalid_api_key` (S101); the only lookup is by sha256.
 * Suspended tenant → 403 `tenant_suspended`; plan without `api_webhooks` → 402 `feature_not_in_plan` (P84-13).
 * Sets the TenantContext (role kind `api_key`, permissions = the backing permissions of the key's scopes, plus
 * `costs.view` with `include_costs`) and CurrentApiKey (actor plumbing); both are cleared after the response.
 * `last_used_at` is written at most once per minute per key (no `updated_at` bump, Q130).
 * Runs before the throttle (the `external-api` limiter keys by key id) and before route-model binding.
 */
class AuthenticateApiKey
{
    public const ALIAS = 'apikey';

    public const ROLE = 'api_key';

    /** Request attribute holding the authenticated ApiKey. */
    public const ATTRIBUTE = 'storeplix.api_key';

    public function __construct(
        private readonly PreTenantLookup $lookup,
        private readonly TenantContext $context,
        private readonly CurrentApiKey $current,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $plain = (string) $request->bearerToken();
        if (preg_match(ApiKey::PLAIN_PATTERN, $plain) !== 1) {
            throw self::invalid();
        }

        $owner = $this->lookup->apiKeyOwner(ApiKeyService::hash($plain));
        $tenant = $owner === null ? null : Tenant::query()->find($owner['tenant_id']);
        if ($owner === null || $tenant === null) {
            throw self::invalid();
        }

        try {
            $this->context->set($tenant, self::ROLE, PermissionSet::none());
            $key = ApiKey::query()->whereKey($owner['key_id'])->whereNull('revoked_at')->first();
            if ($key === null || ! hash_equals($key->key_hash, ApiKeyService::hash($plain))) {
                throw self::invalid();
            }
            if (! $tenant->isActive()) {
                throw new ApiException(403, 'tenant_suspended', 'This tenant is suspended.');
            }
            FeatureGate::assertAllows($tenant, Feature::ApiWebhooks);

            $this->context->set($tenant, self::ROLE, ApiScope::permissionsFor($key->grantedScopes(), (bool) $key->include_costs));
            $this->current->set($key);
            $request->attributes->set(self::ATTRIBUTE, $key);
            $this->touch($key);

            $response = $next($request);
        } finally {
            $this->current->clear();
            $this->context->clear();
        }

        return self::withRateLimitHeaders($response);
    }

    public static function invalid(): ApiException
    {
        return new ApiException(401, 'invalid_api_key', 'The API key is missing, invalid or revoked.');
    }

    /** Q130: at most one `last_used_at` write per key and minute (tenant-prefixed cache key). */
    private function touch(ApiKey $key): void
    {
        if (Cache::add(app(TenantCache::class)->key('api-key-used:'.$key->id), 1, 60)) {
            ApiKey::query()->whereKey($key->id)->toBase()->update(['last_used_at' => now()]);
        }
    }

    /** §3: IETF `RateLimit-*` names next to Laravel's `X-RateLimit-*`. */
    private static function withRateLimitHeaders(Response $response): Response
    {
        foreach (['Limit', 'Remaining', 'Reset'] as $name) {
            $value = $response->headers->get('X-RateLimit-'.$name);
            if ($value !== null) {
                $response->headers->set('RateLimit-'.$name, $value);
            }
        }

        return $response;
    }
}
