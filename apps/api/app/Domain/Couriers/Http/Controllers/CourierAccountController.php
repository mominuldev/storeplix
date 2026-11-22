<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Http\Controllers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Couriers\AreaMapper;
use App\Domain\Couriers\CourierAccountPresenter;
use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\Drivers\CourierArea;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Drivers\PickupStore;
use App\Domain\Couriers\Http\Requests\ConnectCourierRequest;
use App\Domain\Couriers\Http\Requests\CourierAreasRequest;
use App\Domain\Couriers\Http\Requests\CourierSettingsRules;
use App\Domain\Couriers\Http\Requests\UpdateCourierRequest;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;

/**
 * Couriers (PHASE-5B §4.6, P5B-31/32/37/39; S26, S27, S38): list, connect (live credential check first, then save),
 * settings / default, test, webhook-secret rotation, disconnect, area and pickup-store lookups. Reads O A S; writes
 * O A (`integrations.manage`). Credentials and webhook secrets are never returned (the secret once, in
 * `meta.webhook_secret` / the rotate answer) or logged; audits carry provider and mode only. No row lock is held
 * across a courier call.
 */
final class CourierAccountController
{
    public function __construct(
        private readonly CourierManager $couriers,
        private readonly AreaMapper $areas,
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
    ) {}

    public function index(Store $store): JsonResponse
    {
        Gate::authorize('integrations.view', $store);
        $rows = CourierAccount::query()->where('store_id', $store->id)->with('connectedBy')->get()->keyBy('provider');

        return new JsonResponse(['data' => array_map(
            fn (string $provider) => CourierAccountPresenter::present($rows[$provider] ?? null, $provider),
            CourierAccount::PROVIDERS,
        )]);
    }

    public function connect(ConnectCourierRequest $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $mode = (string) $request->validated('mode');
        $credentials = $request->credentials();
        [$pickup, $settings] = CourierSettingsRules::split($request->settings());
        $existing = $this->account($store, $provider);
        if (! self::counts($existing)) {
            FeatureGate::assertWithin($this->tenant($store), Limit::CourierConnections); // cheap early 402
        }

        // 1. Live credential check with an unsaved candidate (no transaction, no lock).
        $candidate = new CourierAccount;
        $candidate->id = $existing->id ?? strtolower((string) Str::ulid());
        $candidate->tenant_id = $store->tenant_id;
        $candidate->store_id = $store->id;
        $candidate->provider = $provider;
        $candidate->mode = $mode;
        $candidate->credentials = $credentials;
        try {
            $this->couriers->driver($provider)->checkCredentials($candidate);
        } catch (CourierException $e) {
            throw self::apiError($e);
        }

        // 2. Save (serialised per store by the store row lock; the plan limit is re-checked under it).
        $secret = null;
        $account = DB::transaction(function () use ($store, $provider, $mode, $credentials, $candidate, $request, $pickup, $settings, &$secret) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->account($store, $provider);
            if (! self::counts($account)) {
                FeatureGate::assertWithin($this->tenant($store), Limit::CourierConnections);
            }
            $replaced = $account !== null && $account->status !== CourierAccount::DISCONNECTED;
            if ($account === null) {
                $account = new CourierAccount;
                $account->id = $candidate->id;
                $account->store_id = $store->id;
                $account->provider = $provider;
                $account->route_key = CourierAccount::newRouteKey();
                $account->revision = 1;
            } else {
                $account->revision++;
            }
            if (! $replaced) {
                $account->connected_at = now();
            }
            $account->mode = $mode;
            $account->credentials = $credentials;
            $account->credentials_hint = CourierAccount::hintFor($provider, $credentials);
            $account->status = CourierAccount::CONNECTED;
            $account->last_checked_at = now();
            $account->last_error_code = null;
            $account->connected_by = $request->user()?->getKey();
            $account->settings = array_merge(is_array($account->settings) ? $account->settings : [], $settings);
            if ($pickup !== false) {
                $account->pickup_location_id = $pickup;
            }
            // P5B-37: we issue the webhook secret (Steadfast bearer / Pathao signature) once; reconnecting keeps it.
            if (in_array($provider, CourierAccount::WEBHOOK_PROVIDERS, true) && $account->webhook_secret_hash === null) {
                $secret = CourierAccount::newWebhookSecret();
                $account->setWebhookSecret($secret);
            }
            if (! CourierAccount::query()->where('store_id', $store->id)->where('is_default', true)->whereKeyNot($account->id)->exists()) {
                $account->is_default = true; // the first connected courier is the default
            }
            $account->save();

            $this->audit->log('integration.connected', $account, ['kind' => 'courier', 'provider' => $provider, 'mode' => $mode, 'replaced' => $replaced]);

            return $account;
        });

        return new JsonResponse([
            'data' => CourierAccountPresenter::present($account->load('connectedBy'), $provider),
            'meta' => ['webhook_secret' => $secret],
        ]);
    }

    public function update(UpdateCourierRequest $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $input = $request->validated();
        [$pickup, $settings] = CourierSettingsRules::split($request->settings());

        $account = DB::transaction(function () use ($store, $provider, $input, $pickup, $settings) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->connected($store, $provider);
            if ((int) $input['revision'] !== $account->revision) {
                throw StoreThemeService::conflict();
            }
            $changed = [];
            $merged = array_merge(is_array($account->settings) ? $account->settings : [], $settings);
            if ($merged !== $account->settings) {
                $account->settings = $merged;
                $changed = array_keys($settings);
            }
            if ($pickup !== false && $pickup !== $account->pickup_location_id) {
                $account->pickup_location_id = $pickup;
                $changed[] = 'pickup_location_id';
            }
            $default = $input['is_default'] ?? null;
            if ($default !== null && $default !== $account->is_default) {
                if ($default) {
                    CourierAccount::query()->where('store_id', $store->id)->whereKeyNot($account->id)->where('is_default', true)
                        ->update(['is_default' => false, 'revision' => DB::raw('revision + 1'), 'updated_at' => now()]);
                }
                $account->is_default = (bool) $default;
                $changed[] = 'is_default';
            }
            if ($changed !== []) {
                $account->revision++;
                $account->save();
                $this->audit->log('integration.updated', $account, ['kind' => 'courier', 'provider' => $provider, 'changed' => array_values(array_unique($changed))]);
            }

            return $account;
        });

        return new JsonResponse(['data' => CourierAccountPresenter::present($account->load('connectedBy'), $provider)]);
    }

    /** POST …/test: live credential check; a rejection marks the account `error` (credentials_invalid). */
    public function test(Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        $account = $this->connected($store, $provider);
        try {
            $check = $this->couriers->driver($provider)->checkCredentials($account);
        } catch (CourierException $e) {
            if ($e->errorCode === CourierException::CREDENTIALS_INVALID) {
                CourierAccount::query()->whereKey($account->id)->update([
                    'status' => CourierAccount::ERROR, 'last_error_code' => CourierException::CREDENTIALS_INVALID,
                    'last_checked_at' => now(), 'updated_at' => now(),
                ]);
            }
            throw self::apiError($e);
        }
        $now = now();
        CourierAccount::query()->whereKey($account->id)->update([
            'status' => CourierAccount::CONNECTED, 'last_error_code' => null, 'last_checked_at' => $now, 'updated_at' => $now,
        ]);

        $data = ['ok' => $check->ok, 'checked_at' => $now->toIso8601ZuluString()];
        if ($check->balanceAmount !== null) {
            $data['balance_amount'] = $check->balanceAmount;
        }

        return new JsonResponse(['data' => $data]);
    }

    /** POST …/webhook-secret: a new secret (shown once); the old one stops working at once. */
    public function rotateWebhookSecret(Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.manage', $store);
        if (! in_array($provider, CourierAccount::WEBHOOK_PROVIDERS, true) || ! $this->couriers->driver($provider)->supportsWebhooks()) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        $secret = CourierAccount::newWebhookSecret();
        $account = DB::transaction(function () use ($store, $provider, $secret) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->connected($store, $provider);
            $account->setWebhookSecret($secret);
            $account->revision++;
            $account->save();
            $this->audit->log('integration.updated', $account, ['kind' => 'courier', 'provider' => $provider, 'changed' => ['webhook_secret']]);

            return $account;
        });

        return new JsonResponse(['data' => ['webhook_url' => CourierAccountPresenter::webhookUrl($account), 'webhook_secret' => $secret]]);
    }

    public function disconnect(Store $store, string $provider): Response
    {
        Gate::authorize('integrations.manage', $store);

        DB::transaction(function () use ($store, $provider) {
            Store::query()->whereKey($store->id)->lockForUpdate()->first();
            $account = $this->connected($store, $provider);
            $busy = Shipment::query()->where('store_id', $store->id)->where('courier_account_id', $account->id)
                ->whereIn('status', array_values(array_diff(Shipment::ACTIVE_STATUSES, [Shipment::SHIPPED])))->exists();
            if ($busy) {
                throw new ApiException(409, 'courier_busy', 'This courier still has parcels on the way. Disconnect it when they are delivered or returned.');
            }
            $account->credentials = [];
            $account->credentials_hint = null;
            $account->setWebhookSecret(null);
            $account->status = CourierAccount::DISCONNECTED;
            $account->is_default = false;
            $account->last_error_code = null;
            $account->connected_at = null;
            $account->revision++;
            $account->save();

            $this->audit->log('integration.disconnected', $account, ['kind' => 'courier', 'provider' => $provider]);
        });

        return response()->noContent();
    }

    /** GET …/areas?level=&parent_id= (+ district_code/thana_code → meta.suggested). Cached 24 h per account. */
    public function areas(CourierAreasRequest $request, Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.view', $store);
        $account = $this->connected($store, $provider);
        $level = (string) $request->validated('level');
        $parent = $request->validated('parent_id');
        try {
            $areas = $this->areas->areas($account, $level, is_string($parent) && $parent !== '' ? $parent : null);
            $body = ['data' => array_map(fn (CourierArea $a) => $a->toArray(), $areas)];
            $district = $request->validated('district_code');
            if (is_string($district) && $district !== '') {
                $thana = $request->validated('thana_code');
                $body['meta'] = ['suggested' => $this->areas->suggest($account, $district, is_string($thana) ? $thana : null)];
            }
        } catch (CourierException $e) {
            throw self::apiError($e);
        }

        return new JsonResponse($body);
    }

    /** GET …/pickup-stores: the courier's own pickup stores (Pathao stores, RedX pickup stores; Steadfast []). */
    public function pickupStores(Store $store, string $provider): JsonResponse
    {
        Gate::authorize('integrations.view', $store);
        $account = $this->connected($store, $provider);
        try {
            $stores = $this->couriers->driver($provider)->pickupStores($account);
        } catch (CourierException $e) {
            throw self::apiError($e);
        }

        return new JsonResponse(['data' => array_map(fn (PickupStore $s) => $s->toArray(), $stores)]);
    }

    private function account(Store $store, string $provider): ?CourierAccount
    {
        return CourierAccount::query()->where('store_id', $store->id)->where('provider', $provider)->first();
    }

    /** A connected (or erroring) account, else 404. */
    private function connected(Store $store, string $provider): CourierAccount
    {
        $account = $this->account($store, $provider);
        if (! self::counts($account)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $account;
    }

    /** Counts towards `courier_connections`: a row that is connected or erroring (not disconnected). */
    private static function counts(?CourierAccount $account): bool
    {
        return $account !== null && $account->status !== CourierAccount::DISCONNECTED;
    }

    private function tenant(Store $store): Tenant
    {
        $tenant = $this->context->tenant();

        return $tenant !== null && $tenant->getKey() === $store->tenant_id ? $tenant : Tenant::query()->findOrFail($store->tenant_id);
    }

    private static function apiError(CourierException $e): ApiException
    {
        return match ($e->errorCode) {
            CourierException::CREDENTIALS_INVALID => new ApiException(422, 'credentials_invalid', 'The courier rejected these credentials. Check them and try again.',
                $e->field !== null ? ["credentials.{$e->field}" => ['Rejected by the courier.']] : null),
            CourierException::NOT_CONNECTED => new ApiException(422, 'gateway_not_connected', 'This courier isn\'t available in this mode yet.'),
            CourierException::COURIER_REJECTED => new ApiException(422, 'validation_failed', 'The given data was invalid.', [$e->field ?? 'level' => [$e->getMessage()]]),
            default => new ApiException(502, 'provider_unavailable', 'The courier isn\'t responding. Nothing was changed; try again in a few minutes.'),
        };
    }
}
