<?php

declare(strict_types=1);

namespace App\Domain\Integrations;

use App\Domain\Ai\AiGenerationService;
use App\Domain\Billing\FeatureGate;
use App\Domain\Catalog\Models\Category;
use App\Domain\Feeds\FeedService;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\Settings\ProviderSettings;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Tracking\Drivers\DeliveryResult;
use App\Domain\Tracking\Drivers\TrackingDrivers;
use App\Domain\Tracking\Models\TrackingEvent;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use SensitiveParameter;

/**
 * PHASE-8-9D §4 registry lifecycle: connect / replace (PUT, tracking + AI), settings (PATCH), disconnect (typed
 * DISCONNECT) and verify. Writes are revision compare-and-set under a row lock; a concurrent first connect loses on
 * U(store_id, provider) and answers 409 `revision_conflict`. Credentials merge field by field (omitted = keep), are
 * encrypted (P89D-5) and only ever presented as `••••` + last 4. Provider calls (live token checks) run before the write
 * transaction, never under a lock. Audit meta: provider, changed keys, credential field names + hints (P89D-23).
 */
final class IntegrationService
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
        private readonly TrackingDrivers $drivers,
    ) {}

    public static function find(Store $store, string $provider): ?StoreIntegration
    {
        return StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->first();
    }

    /** 422 `integration_not_connected` unless a usable row exists (not disconnected; feeds also past OAuth when $ready). */
    public static function requireConnected(Store $store, string $provider, bool $ready = false): StoreIntegration
    {
        $row = self::find($store, $provider);
        if ($row === null || $row->status === StoreIntegration::DISCONNECTED || ($ready && $row->status === StoreIntegration::SETUP_REQUIRED)) {
            throw new ApiException(422, 'integration_not_connected', 'Connect this integration first.');
        }

        return $row;
    }

    public function assertPlan(string $provider): void
    {
        $feature = IntegrationProvider::feature($provider);
        $tenant = $this->context->tenant();
        if ($feature !== null && $tenant !== null) {
            FeatureGate::assertAllows($tenant, $feature);
        }
    }

    /**
     * PUT (§4.2): tracking and AI providers only.
     *
     * @param  array<string, mixed>  $input  {settings, credentials?, revision?}
     */
    public function save(Store $store, string $provider, #[SensitiveParameter] array $input, User $by): StoreIntegration
    {
        if (IntegrationProvider::isFeed($provider)) {
            throw new ApiException(422, 'integration_setup_required', 'Connect this sales channel with “Continue with …” (OAuth).');
        }
        $this->assertPlan($provider);
        if ($provider === IntegrationProvider::AI_PHOTOS && ! AiGenerationService::photosAvailable()) {
            // P89D-39 / Q358: no image provider in production yet — the card shows "Coming soon".
            throw new ApiException(422, 'integration_setup_required', 'AI product photos are coming soon.');
        }
        $class = ProviderSettings::for($provider);
        $existing = self::find($store, $provider);
        $live = $existing !== null && $existing->status !== StoreIntegration::DISCONNECTED;
        if ($existing !== null && ! array_key_exists('revision', $input)) {
            throw ValidationException::withMessages(['revision' => ['Reload the page and try again.']]);
        }
        if ($existing !== null && (int) $input['revision'] !== $existing->revision) {
            throw self::conflict();
        }
        $settings = $class::validate((array) $input['settings'], $live ? (array) $existing->settings : []);
        $this->assertCategories($store, $settings);
        [$credentials, $replaced] = self::mergeCredentials($class, $live ? $existing->secrets() : [], $input['credentials'] ?? null);

        // Live check before any lock (§4.2): auth → 422; provider down → 502 (GTM: save with endpoint_unreachable).
        $attention = [];
        $verified = false;
        if (IntegrationProvider::isTracking($provider)) {
            $probe = new StoreIntegration;
            $probe->forceFill(['id' => $existing?->id ?? 'probe', 'store_id' => $store->id, 'provider' => $provider, 'settings' => $settings, 'credentials' => $credentials]);
            $result = $this->drivers->for($provider)->check($probe);
            $attention = $this->checkOutcome($provider, $result);
            $verified = $result->delivered;
        }

        try {
            $row = DB::transaction(function () use ($store, $provider, $input, $settings, $credentials, $class, $attention, $verified, $by, $replaced) {
                $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->lockForUpdate()->first();
                if ($row !== null && (! array_key_exists('revision', $input) || (int) $input['revision'] !== $row->revision)) {
                    throw self::conflict();
                }
                $new = $row === null || $row->status === StoreIntegration::DISCONNECTED;
                $row ??= new StoreIntegration;
                $before = $new ? [] : (array) $row->settings;
                $set = [];
                $remove = ['plan_required', 'token_invalid', 'token_expired'];
                foreach ($attention as $reason) {
                    $set[$reason] = null;
                }
                if (! in_array('endpoint_unreachable', $attention, true)) {
                    $remove[] = 'endpoint_unreachable';
                }
                $row->forceFill([
                    'store_id' => $store->id,
                    'provider' => $provider,
                    'settings' => $settings,
                    'credentials' => $class::credentialFields() === [] ? null : $credentials,
                    'credentials_hint' => self::hints($class, $credentials),
                    'status' => $new ? StoreIntegration::CONNECTED : $row->status,
                    'attention' => $new ? [] : $row->attention,
                    'last_verified_at' => $verified ? now() : ($new ? null : $row->last_verified_at),
                    'last_error_code' => null,
                    'connected_by' => $new ? $by->id : $row->connected_by,
                    'connected_at' => $new ? now() : $row->connected_at,
                    'disconnected_at' => null,
                    'revision' => $row->exists ? $row->revision + 1 : 1,
                ])->save();
                IntegrationAttention::apply($row, $set, $remove);

                $this->auditSave($row, $new, $before, $settings, $replaced, $class, $by);
                if (IntegrationProvider::isTracking($provider)) {
                    RevalidateStorefront::dispatch($store->id)->forTenant($this->context->requireId())->afterCommit();
                }

                return $row;
            });
        } catch (UniqueConstraintViolationException) {
            throw self::conflict();
        }

        return $row->refresh();
    }

    /**
     * PATCH (§4.2): partial settings with `revision`; never credentials.
     *
     * @param  array<string, mixed>  $input  {settings, revision}
     */
    public function patch(Store $store, string $provider, array $input, User $by): StoreIntegration
    {
        $this->assertPlan($provider);
        $existing = self::requireConnected($store, $provider);
        $class = ProviderSettings::for($provider);
        if ((int) $input['revision'] !== $existing->revision) {
            throw self::conflict();
        }
        $settings = $class::validate((array) $input['settings'], (array) $existing->settings);
        $this->assertCategories($store, $settings);

        return DB::transaction(function () use ($store, $provider, $input, $settings, $by) {
            $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->lockForUpdate()->firstOrFail();
            if ((int) $input['revision'] !== $row->revision) {
                throw self::conflict();
            }
            $changed = self::changedKeys((array) $row->settings, $settings);
            if ($changed === []) {
                return $row;
            }
            $row->settings = $settings;
            $row->revision++;
            $row->save();
            $this->audit->log('integration.updated', null, ['provider' => $provider, 'store_id' => $store->id, 'changed' => $changed], $by);
            if (IntegrationProvider::isTracking($provider)) {
                RevalidateStorefront::dispatch($store->id)->forTenant($this->context->requireId())->afterCommit();
            }
            if (IntegrationProvider::isFeed($provider) && $row->isActive()) {
                app(FeedService::class)->settingsChanged($row);
            }

            return $row;
        })->refresh();
    }

    /** Disconnect / turn off (§4.6, P89D-31). Idempotent. */
    public function disconnect(Store $store, string $provider, User $by): ?StoreIntegration
    {
        $existing = self::find($store, $provider);
        if ($existing === null || $existing->status === StoreIntegration::DISCONNECTED) {
            return $existing;
        }
        if (IntegrationProvider::isFeed($provider)) {
            app(FeedService::class)->revoke($existing); // best effort, outside any transaction
        }
        $row = DB::transaction(function () use ($store, $provider, $by) {
            $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->lockForUpdate()->firstOrFail();
            if ($row->status === StoreIntegration::DISCONNECTED) {
                return $row;
            }
            $settings = (array) $row->settings;
            if ($provider === IntegrationProvider::GOOGLE_MERCHANT) {
                $settings['website_claimed'] = false;
            }
            $row->forceFill([
                'status' => StoreIntegration::DISCONNECTED, 'settings' => $settings, 'credentials' => null, 'credentials_hint' => [], 'attention' => [],
                'token_expires_at' => null, 'last_error_code' => null, 'disconnected_at' => now(), 'revision' => $row->revision + 1,
            ])->save();
            DB::table('tracking_events')->where('store_integration_id', $row->id)->whereIn('status', TrackingEvent::OPEN)
                ->update(['status' => TrackingEvent::SKIPPED, 'skip_reason' => 'disabled', 'payload' => null, 'next_attempt_at' => null, 'updated_at' => now()]);
            $items = 0;
            if (IntegrationProvider::isFeed($provider)) {
                $items = DB::table('catalog_items')->where('store_integration_id', $row->id)->delete();
            }
            $this->audit->log(IntegrationProvider::isAi($provider) ? 'integration.turned_off' : 'integration.disconnected', null,
                array_filter(['provider' => $provider, 'store_id' => $store->id, 'items_deleted' => IntegrationProvider::isFeed($provider) ? $items : null], fn ($v) => $v !== null), $by);
            if (IntegrationProvider::isTracking($provider) || $provider === IntegrationProvider::GOOGLE_MERCHANT) {
                RevalidateStorefront::dispatch($store->id)->forTenant($this->context->requireId())->afterCommit();
            }

            return $row;
        });

        return $row->refresh();
    }

    /** @return array<string, mixed> IntegrationCheck (§4.5) */
    public function verify(Store $store, string $provider): array
    {
        $row = self::requireConnected($store, $provider);
        $rows = [];
        $found = null;
        $set = [];
        $remove = [];
        if (IntegrationProvider::isTracking($provider)) {
            $rows[] = self::row('id_format', 'ID format', 'ok', null);
            $result = $this->drivers->for($provider)->check($row);
            $found = $result->foundName;
            if ($provider === IntegrationProvider::GTM_SERVER) {
                $rows[] = self::row('endpoint', 'Tagging server', $result->delivered ? 'ok' : ($result->errorCode === DeliveryResult::BLOCKED ? 'fail' : 'warn'),
                    $result->delivered ? 'Healthy' : ($result->errorCode === DeliveryResult::BLOCKED ? 'This address is not allowed.' : 'The tagging server did not answer /healthy.'));
                $result->delivered ? $remove[] = 'endpoint_unreachable' : $set['endpoint_unreachable'] = null;
            } else {
                $state = $result->delivered ? 'ok' : ($result->errorCode === DeliveryResult::AUTH ? 'fail' : 'warn');
                $rows[] = self::row('token', $provider === IntegrationProvider::GA4 ? 'API secret' : 'Access token', $state,
                    match ($state) {
                        'ok' => 'Valid', 'fail' => 'The provider refused this token. Replace it.', default => 'The provider did not answer. Try again later.'
                    });
                if ($result->errorCode === DeliveryResult::AUTH) {
                    $set['token_invalid'] = null;
                } elseif ($result->delivered) {
                    $remove[] = 'token_invalid';
                }
                if ($provider === IntegrationProvider::META_PIXEL) {
                    $rows[] = self::row('found', 'Pixel found', $found !== null ? 'ok' : 'skipped', $found);
                }
            }
            $last = TrackingEvent::query()->where('store_integration_id', $row->id)->where('channel', TrackingEvent::SERVER)->where('test', false)
                ->where('status', TrackingEvent::DELIVERED)->where('delivered_at', '>=', now()->subDay())->count();
            $rows[] = self::row('server_events', 'Server events (24 h)', $last > 0 ? 'ok' : 'warn', $last > 0 ? number_format($last).' delivered' : 'None yet');
            $rows[] = self::row('consent', 'Cookie consent', 'ok', (bool) $row->setting('wait_for_consent') ? 'Waits for consent' : 'Not required');
            if (in_array($provider, [IntegrationProvider::META_PIXEL, IntegrationProvider::TIKTOK_PIXEL], true)) {
                $rows[] = self::row('test_code', 'Test event code', $row->setting('test_event_code') !== null ? 'ok' : 'skipped', $row->setting('test_event_code') !== null ? 'Saved' : 'Not saved');
            }
        } elseif (IntegrationProvider::isFeed($provider)) {
            [$rows, $set, $remove, $found] = app(FeedService::class)->verify($store, $row);
        } else {
            $rows[] = self::row('provider', 'AI provider', 'ok', 'Reachable');
        }
        DB::transaction(function () use ($row, $set, $remove) {
            $locked = StoreIntegration::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            $locked->last_verified_at = now();
            $locked->save();
            if ($locked->status !== StoreIntegration::DISCONNECTED) {
                IntegrationAttention::apply($locked, $set, $remove);
            }
        });

        return [
            'provider' => $provider,
            'ok' => collect($rows)->every(fn (array $r) => $r['state'] !== 'fail'),
            'checked_at' => now()->toIso8601ZuluString(),
            'rows' => $rows,
            'found_name' => $found,
        ];
    }

    /** @return array{key: string, label: string, state: string, detail: string|null} */
    public static function row(string $key, string $label, string $state, ?string $detail): array
    {
        return ['key' => $key, 'label' => $label, 'state' => $state, 'detail' => $detail];
    }

    public static function conflict(): ApiException
    {
        return new ApiException(409, 'revision_conflict', 'This integration was changed by someone else. Reload and try again.');
    }

    /**
     * @param  class-string<ProviderSettings>  $class
     * @param  array<string, mixed>  $stored
     * @return array{0: array<string, string>, 1: list<string>} merged secrets, replaced field names
     */
    public static function mergeCredentials(string $class, #[SensitiveParameter] array $stored, #[SensitiveParameter] mixed $input): array
    {
        $fields = $class::credentialFields();
        if ($input !== null && ! is_array($input)) {
            throw ValidationException::withMessages(['credentials' => ['The credentials must be an object.']]);
        }
        $input = (array) $input;
        $errors = [];
        foreach (array_keys($input) as $key) {
            if (! isset($fields[$key])) {
                $errors["credentials.{$key}"] = ['This field does not exist.'];
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
        $merged = array_intersect_key($stored, $fields);
        $replaced = [];
        foreach ($fields as $key => [$min, $max]) {
            $value = $input[$key] ?? null;
            if ($value === null || $value === '') {
                continue;
            }
            if (! is_string($value)) {
                throw ValidationException::withMessages(["credentials.{$key}" => ['Paste the value as text.']]);
            }
            $value = trim($value);
            if (ProviderSettings::looksLikeCode($value)) {
                throw new ApiException(422, 'integration_code_pasted', 'This looks like code. Paste only the token.', ['field' => "credentials.{$key}"]);
            }
            if (mb_strlen($value) < $min || mb_strlen($value) > $max || preg_match('/\s/u', $value) === 1) {
                throw ValidationException::withMessages(["credentials.{$key}" => ["This doesn't look like a valid value ({$min}–{$max} characters, no spaces)."]]);
            }
            $merged[$key] = $value;
            $replaced[] = $key;
        }
        foreach ($class::requiredCredentials() as $key) {
            if (! isset($merged[$key]) || $merged[$key] === '') {
                $errors["credentials.{$key}"] = ['Paste the '.str_replace('_', ' ', $key).'.'];
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return [$merged, $replaced];
    }

    /** @param class-string<ProviderSettings> $class @param array<string, mixed> $credentials @return array<string, string> */
    public static function hints(string $class, #[SensitiveParameter] array $credentials): array
    {
        $hints = [];
        foreach (array_keys($class::credentialFields()) as $key) {
            if (is_string($credentials[$key] ?? null) && $credentials[$key] !== '') {
                $hints[$key] = IntegrationCredentials::hint($credentials[$key]);
            }
        }

        return $hints;
    }

    /** @param array<string, mixed> $before @param array<string, mixed> $after @return list<string> */
    public static function changedKeys(array $before, array $after): array
    {
        $changed = [];
        foreach ($after as $key => $value) {
            if (! array_key_exists($key, $before) || $before[$key] !== $value) {
                $changed[] = (string) $key;
            }
        }

        return $changed;
    }

    /** Feed category filters name categories of this store only (S330). @param array<string, mixed> $settings */
    private function assertCategories(Store $store, array $settings): void
    {
        $ids = (array) ($settings['category_ids'] ?? []);
        if ($ids === []) {
            return;
        }
        $found = Category::query()->where('store_id', $store->id)->whereIn('id', $ids)->count();
        if ($found !== count($ids)) {
            throw ValidationException::withMessages(['settings.category_ids' => ['Choose categories of this shop.']]);
        }
    }

    /** @return list<string> attention reasons to set */
    private function checkOutcome(string $provider, DeliveryResult $result): array
    {
        if ($result->delivered) {
            return [];
        }
        $field = $provider === IntegrationProvider::GA4 ? 'credentials.api_secret' : 'credentials.access_token';

        return match (true) {
            $result->errorCode === DeliveryResult::BLOCKED => throw new ApiException(422, 'integration_endpoint_blocked',
                'This tagging server address is not allowed (it must resolve to a public address on port 443).', ['field' => 'settings.tagging_server_url']),
            $provider === IntegrationProvider::GTM_SERVER => ['endpoint_unreachable'],
            $result->errorCode === DeliveryResult::AUTH => throw new ApiException(422, 'integration_credentials_invalid',
                (IntegrationProvider::LABELS[$provider] ?? 'The provider').' refused this token. Check it and paste it again.', ['field' => $field]),
            $result->errorCode === DeliveryResult::REJECTED => throw new ApiException(422, 'integration_credentials_invalid',
                (IntegrationProvider::LABELS[$provider] ?? 'The provider')." couldn't find this ID with this token.", ['field' => $field]),
            default => throw new ApiException(502, 'provider_unavailable', (IntegrationProvider::LABELS[$provider] ?? 'The provider')." didn't answer. Nothing was saved; try again in a minute."),
        };
    }

    /**
     * @param  array<string, mixed>  $before
     * @param  array<string, mixed>  $settings
     * @param  list<string>  $replaced
     * @param  class-string<ProviderSettings>  $class
     */
    private function auditSave(StoreIntegration $row, bool $new, array $before, array $settings, array $replaced, string $class, User $by): void
    {
        $meta = ['provider' => $row->provider, 'store_id' => $row->store_id];
        $hints = array_intersect_key((array) $row->credentials_hint, array_flip($replaced));
        if ($new) {
            $action = IntegrationProvider::isAi($row->provider) ? 'integration.turned_on' : 'integration.connected';
            $this->audit->log($action, null, $meta + ['credential_fields' => array_keys($class::credentialFields()), 'credentials_hint' => (array) $row->credentials_hint], $by);

            return;
        }
        $changed = self::changedKeys($before, $settings);
        if ($changed !== []) {
            $this->audit->log('integration.updated', null, $meta + ['changed' => $changed], $by);
        }
        if ($replaced !== []) {
            $this->audit->log('integration.credentials_replaced', null, $meta + ['fields' => $replaced, 'credentials_hint' => $hints], $by);
        }
    }
}
