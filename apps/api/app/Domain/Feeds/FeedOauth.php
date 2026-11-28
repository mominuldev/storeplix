<?php

declare(strict_types=1);

namespace App\Domain\Feeds;

use App\Domain\Feeds\Drivers\FeedDrivers;
use App\Domain\Feeds\Drivers\FeedException;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\IntegrationAttention;
use App\Domain\Integrations\Mail\IntegrationAlertMail;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\Settings\ProviderSettings;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9D P89D-26 / §7.1 (S339): OAuth for the product feeds. `state` = encrypted + MAC'd (APP_KEY)
 * `{tenant, store, user, provider, nonce, exp}`; the nonce is single-use in the tenant cache for 10 minutes. The code
 * is exchanged server-side; tokens go straight into the encrypted credentials (never logged, never rendered). The
 * browser is only ever redirected to the merchant app origin.
 */
final class FeedOauth
{
    public function __construct(
        private readonly FeedDrivers $drivers,
        private readonly FeedTokens $tokens,
        private readonly TenantContext $context,
        private readonly TenantCache $cache,
        private readonly AuditLogger $audit,
    ) {}

    public static function redirectUri(string $provider): string
    {
        return rtrim((string) config('feeds.api_url'), '/')."/api/v1/integrations/oauth/{$provider}/callback";
    }

    /** @return array{authorize_url: string, expires_at: string} */
    public function start(Store $store, string $provider, User $user): array
    {
        $nonce = Str::random(40);
        $expires = now()->addMinutes((int) config('feeds.state_ttl_minutes', 10));
        $state = Crypt::encryptString((string) json_encode([
            't' => $this->context->requireId(), 's' => $store->id, 'u' => $user->id, 'p' => $provider, 'n' => $nonce, 'e' => $expires->getTimestamp(),
        ]));
        $this->cache->put('oauth-nonce:'.$nonce, $provider, $expires);

        return ['authorize_url' => $this->drivers->for($provider)->authorizeUrl($state, self::redirectUri($provider)), 'expires_at' => $expires->toIso8601ZuluString()];
    }

    /**
     * Decrypts the state. Null = missing / tampered / malformed (the caller answers 400).
     *
     * @return array{t: string, s: string, u: string, p: string, n: string, e: int}|null
     */
    public static function decode(mixed $state): ?array
    {
        if (! is_string($state) || $state === '' || strlen($state) > 2000) {
            return null;
        }
        try {
            $data = json_decode(Crypt::decryptString($state), true);
        } catch (DecryptException) {
            return null;
        }
        foreach (['t', 's', 'u', 'p', 'n'] as $key) {
            if (! is_string($data[$key] ?? null)) {
                return null;
            }
        }

        return is_int($data['e'] ?? null) ? $data : null;
    }

    /**
     * The provider redirected back: runs inside the state's tenant. Returns the merchant app URL to 303 to.
     *
     * @param  array{t: string, s: string, u: string, p: string, n: string, e: int}  $state
     */
    public function callback(string $provider, array $state, ?string $code, ?string $error): string
    {
        $app = rtrim((string) config('storeplix.merchant_app_url'), '/').'/integrations/'.IntegrationAlertMail::route($provider);
        $fail = fn (string $reason) => $app.'?'.http_build_query(['oauth' => 'error', 'reason' => $reason]);

        return $this->context->run($state['t'], function () use ($provider, $state, $code, $error, $app, $fail) {
            // single use + bound to provider + not expired (a replay or a swapped provider is `state_invalid`)
            if ($state['p'] !== $provider || $state['e'] < now()->getTimestamp() || $this->cache->get('oauth-nonce:'.$state['n']) !== $provider
                || ! Cache::add($this->cache->key('oauth-used:'.$state['n']), 1, 900)) {
                return $fail('state_invalid');
            }
            $this->cache->forget('oauth-nonce:'.$state['n']);
            $store = Store::query()->find($state['s']);
            $user = User::query()->find($state['u']);
            if ($store === null || $user === null || ! $this->stillAllowed($user, $state['t'])) {
                return $fail('state_invalid');
            }
            if ($error !== null) {
                return $fail($error === 'access_denied' ? 'denied' : 'provider_unavailable');
            }
            if ($code === null || $code === '' || strlen($code) > 2000) {
                return $fail('exchange_failed');
            }
            try {
                $tokens = $this->drivers->for($provider)->exchangeCode($code, self::redirectUri($provider));
            } catch (FeedException $e) {
                return $fail($e->reason === FeedException::UNAVAILABLE ? 'provider_unavailable' : 'exchange_failed');
            }
            $this->connect($store, $provider, $tokens, $user);

            return $app.'?oauth=success';
        });
    }

    /** @param array{access_token: string, refresh_token: string|null, expires_at: int|null} $tokens */
    private function connect(Store $store, string $provider, array $tokens, User $user): void
    {
        $write = function () use ($store, $provider, $tokens, $user) {
            $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->lockForUpdate()->first();
            $reconnect = $row !== null && $row->status !== StoreIntegration::DISCONNECTED && $row->status !== StoreIntegration::SETUP_REQUIRED;
            $row ??= new StoreIntegration;
            $class = ProviderSettings::for($provider);
            $settings = $row->exists ? array_replace($class::defaults(), (array) $row->settings) : $class::defaults();
            $keep = $reconnect ? array_intersect_key($row->secrets(), array_flip(['data_source', 'site_verification_token'])) : [];
            $row->forceFill([
                'store_id' => $store->id, 'provider' => $provider, 'settings' => $settings,
                'credentials' => array_filter(['access_token' => $tokens['access_token'], 'refresh_token' => $tokens['refresh_token']] + $keep, fn ($v) => $v !== null),
                'credentials_hint' => [], 'status' => $reconnect ? $row->status : StoreIntegration::SETUP_REQUIRED, 'attention' => $reconnect ? $row->attention : [],
                'token_expires_at' => $tokens['expires_at'] !== null ? now()->setTimestamp($tokens['expires_at']) : null,
                'connected_by' => $user->id, 'connected_at' => now(), 'disconnected_at' => null, 'last_error_code' => null,
                'revision' => $row->exists ? $row->revision + 1 : 1,
            ])->save();
            if ($reconnect) {
                IntegrationAttention::apply($row, [], ['token_invalid', 'token_expired', 'token_expiring']);
            }
            $this->audit->log('integration.oauth_connected', null, ['provider' => $provider, 'store_id' => $store->id, 'reconnect' => $reconnect], $user, platform: false);
        };
        try {
            DB::transaction($write);
        } catch (UniqueConstraintViolationException) {
            DB::transaction($write); // a concurrent first connect created the row: update it
        }
    }

    private function stillAllowed(User $user, string $tenantId): bool
    {
        $membership = DB::table('tenant_users')->where('tenant_id', $tenantId)->where('user_id', $user->id)->first(['role', 'role_id']);
        if ($membership === null) {
            return false;
        }
        if (in_array($membership->role, ['owner', 'admin'], true)) {
            return true;
        }
        if ($membership->role_id === null) {
            return false;
        }

        return DB::table('role_permissions')->where('role_id', $membership->role_id)->where('permission', Permission::IntegrationsManage->value)->exists();
    }
}
