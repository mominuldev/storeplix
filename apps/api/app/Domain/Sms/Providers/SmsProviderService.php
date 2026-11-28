<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Identity\Models\User;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Platform\PlatformSmsDelivery;
use App\Domain\Sms\Platform\PlatformSmsTemplates;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\Routing\SmsBreaker;
use App\Domain\Sms\Routing\SmsDriverFactory;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use SensitiveParameter;

/**
 * PHASE-8-9B §4.6 provider lifecycle (all `manage_settings`, audited with the platform actor, `tenantId: false`):
 * create (draft), update (revision), test, activate (typed name + passed test; locks every non-removed row FOR UPDATE
 * ordered by id), rotate (test the NEW credentials first, swap only on success, S223), remove (never the primary) and
 * refresh balance. Every write runs on the platform connection and flushes the routing cache. Audit meta carries field
 * keys and hints only — never a credential (S220).
 */
final class SmsProviderService
{
    public function __construct(
        private readonly IntegrationCredentials $crypto,
        private readonly SmsDriverFactory $factory,
        private readonly SmsBreaker $breaker,
        private readonly AuditLogger $audit,
        private readonly SmsBalanceService $balances,
    ) {}

    /** @return Builder<SmsProvider> */
    public static function query(): Builder
    {
        return PlatformDb::reroute(SmsProvider::query());
    }

    /** 404 for unknown ids and removed providers. */
    public static function locate(string $id): SmsProvider
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? self::query()->whereKey(strtolower($id))->where('role', '<>', SmsProvider::REMOVED)->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** @param array<string, mixed> $input validated by the request */
    public function create(array $input, User $by): SmsProvider
    {
        $driver = (string) $input['driver'];
        if (! SmsProviderCatalog::available($driver)) {
            throw new ApiException(422, 'sms_provider_driver_unavailable', 'This provider is coming soon. Use "Other (HTTP API)" meanwhile.');
        }
        $credentials = SmsProviderRules::credentials($driver, $input['credentials'] ?? null);
        $settings = SmsProviderRules::settings($driver, $input['settings'] ?? [], [], array_keys($credentials));
        $name = trim((string) $input['name']);
        $this->assertNameFree($name, null);
        $catalogue = SmsProviderCatalog::get($driver);

        $provider = new SmsProvider;
        $provider->forceFill([
            'driver' => $driver, 'name' => $name, 'role' => SmsProvider::DRAFT,
            'credentials_encrypted' => $this->crypto->encrypt($credentials),
            'credentials_hint' => SmsProviderRules::hints($credentials),
            'settings' => $settings,
            'connection_changed_at' => now(), 'created_by' => $by->id,
            'price_masking_paisa' => $catalogue['price_masking_paisa'] ?? null,
            'price_non_masking_paisa' => $catalogue['price_non_masking_paisa'] ?? null,
            'low_threshold_paisa' => (int) config('sms.platform.low_threshold_paisa', 100000),
            'message_groups' => array_values(array_unique((array) $input['message_groups'])),
        ] + self::plain($input));
        $provider->setConnection(PlatformDb::connectionName());
        try {
            $provider->save();
        } catch (UniqueConstraintViolationException) {
            throw self::nameTaken();
        }
        $this->audit->log('sms_provider.created', $provider, ['driver' => $driver, 'name' => $name, 'credential_fields' => array_keys($credentials),
            'credentials_hint' => $provider->credentials_hint], $by, tenantId: false, platform: true);

        return $provider;
    }

    /** @param array<string, mixed> $input */
    public function update(SmsProvider $provider, array $input, User $by): SmsProvider
    {
        if ((int) $input['revision'] !== $provider->revision) {
            throw new ApiException(409, 'revision_conflict', 'This provider was changed by someone else. Reload and try again.');
        }
        $changes = self::plain($input);
        if (array_key_exists('name', $input)) {
            $name = trim((string) $input['name']);
            if ($name !== $provider->name) {
                if ($provider->role !== SmsProvider::DRAFT) {
                    throw ValidationException::withMessages(['name' => ['The name of an active provider can’t change.']]);
                }
                $this->assertNameFree($name, $provider->id);
                $changes['name'] = $name;
            }
        }
        if (array_key_exists('message_groups', $input)) {
            $groups = array_values(array_unique((array) $input['message_groups']));
            if ($provider->role === SmsProvider::PRIMARY && array_diff(SmsRoute::primaryRequired(), $groups) !== []) {
                throw ValidationException::withMessages(['message_groups' => ['The primary must carry shop, registration, billing and security SMS.']]);
            }
            $changes['message_groups'] = $groups;
        }
        if (array_key_exists('settings', $input) && is_array($input['settings']) && $input['settings'] !== []) {
            if ($provider->role !== SmsProvider::DRAFT) {
                throw ValidationException::withMessages(['settings' => ['Change the account ID or endpoint of an active provider with Rotate (it needs a test).']]);
            }
            $settings = SmsProviderRules::settings($provider->driver, $input['settings'], (array) $provider->settings, array_keys((array) $provider->credentials_hint));
            if ($settings != (array) $provider->settings) {
                $changes['settings'] = $settings;
                $changes['connection_changed_at'] = now();
            }
        }
        if (($changes['promotional_sender_id'] ?? $provider->promotional_sender_id) === null) {
            $changes['promotional_sender_status'] = null;
        }
        $changed = array_keys(array_filter($changes, fn ($v, $k) => $k === 'connection_changed_at' || $provider->getAttribute($k) != $v, ARRAY_FILTER_USE_BOTH));
        $moved = self::query()->whereKey($provider->id)->where('revision', $provider->revision)
            ->update(array_map(fn ($v) => is_array($v) ? json_encode($v) : $v, $changes) + ['revision' => $provider->revision + 1, 'updated_at' => now()]);
        if ($moved !== 1) {
            throw new ApiException(409, 'revision_conflict', 'This provider was changed by someone else. Reload and try again.');
        }
        SmsRoutingTable::flush();
        $provider = self::locate($provider->id);
        $this->audit->log('sms_provider.updated', $provider, ['changed' => array_values(array_diff($changed, ['connection_changed_at']))], $by, tenantId: false, platform: true);

        return $provider;
    }

    /**
     * §4.6 test with the STORED credentials through this provider only (breaker ignored); records last_test_*; reads the
     * balance when the driver supports it. A failed test is a result, not an error.
     *
     * @return array<string, mixed> SmsProviderTestResult
     */
    public function test(SmsProvider $provider, string $phone, User $by): array
    {
        $msisdn = self::phone($phone);
        $connection = SmsDriverFactory::connect($this->crypto->decrypt((string) $provider->credentials_encrypted), (array) $provider->settings,
            (int) $provider->failover_timeout_seconds, $provider->id);
        $result = $this->sendTest($provider->driver, $connection, $provider->name, $provider->default_sender_id, $msisdn, $provider->id);
        $passed = $result['status'] === SmsProvider::PASSED;
        self::query()->whereKey($provider->id)->update([
            'last_test_at' => now(), 'last_test_status' => $result['status'], 'last_test_error_code' => $result['error_code'],
            'last_test_by' => $by->id, 'updated_at' => now(),
        ]);
        if ($passed) {
            $result['balance_paisa'] = $this->balances->refresh(self::locate($provider->id), $connection)?->balance_amount;
        }
        SmsRoutingTable::flush();
        $this->audit->log('sms_provider.tested', $provider, ['status' => $result['status'], 'error_code' => $result['error_code'], 'to_masked' => $result['to_masked']],
            $by, tenantId: false, platform: true);

        return $result;
    }

    /** §4.6 / P89B-6 / P89B-7. */
    public function activate(SmsProvider $target, string $role, ?string $confirmName, bool $keepPrevious, User $by): void
    {
        $db = PlatformDb::connection();
        try {
            $meta = $db->transaction(function () use ($target, $role, $confirmName, $keepPrevious) {
                $rows = self::query()->where('role', '<>', SmsProvider::REMOVED)->orderBy('id')->lockForUpdate()->get()->keyBy('id');
                $target = $rows->get($target->id) ?? throw new ApiException(404, 'not_found', 'Resource not found.');
                if ($target->role === $role || $target->role === SmsProvider::PRIMARY) {
                    throw new ApiException(409, 'invalid_state_transition', "This provider is already the {$target->role}.");
                }
                if ($role === SmsProvider::PRIMARY) {
                    self::assertName($target, $confirmName);
                    if (array_diff(SmsRoute::primaryRequired(), (array) $target->message_groups) !== []) {
                        throw ValidationException::withMessages(['message_groups' => ['The primary must carry shop, registration, billing and security SMS.']]);
                    }
                }
                if ($target->testRequired()) {
                    throw new ApiException(409, 'sms_provider_test_required', 'Send a passing test SMS with the current connection first.');
                }
                $primary = $rows->first(fn (SmsProvider $p) => $p->role === SmsProvider::PRIMARY);
                $failover = $rows->first(fn (SmsProvider $p) => $p->role === SmsProvider::FAILOVER && $p->id !== $target->id);
                $set = fn (SmsProvider $p, string $r, array $extra = []) => self::query()->whereKey($p->id)
                    ->update(['role' => $r, 'revision' => $p->revision + 1, 'updated_at' => now()] + $extra);
                $base = ['activated_at' => now(), 'activated_by' => null];

                if ($role === SmsProvider::FAILOVER) {
                    if ($failover !== null) {
                        $set($failover, SmsProvider::INACTIVE);
                    }
                    $set($target, SmsProvider::FAILOVER, $base);

                    return ['role' => $role, 'previous_primary_id' => $primary?->id, 'previous_failover_id' => $failover?->id, 'first' => false];
                }
                if ($primary !== null) {
                    $set($primary, SmsProvider::INACTIVE);
                }
                $demoteFailover = $primary !== null && $keepPrevious;
                if ($failover !== null && $demoteFailover) {
                    $set($failover, SmsProvider::INACTIVE);
                }
                $set($target, SmsProvider::PRIMARY, $base);
                if ($demoteFailover) {
                    self::query()->whereKey($primary->id)->update(['role' => SmsProvider::FAILOVER, 'updated_at' => now()]);
                }

                return ['role' => $role, 'previous_primary_id' => $primary?->id, 'previous_failover_id' => $failover?->id, 'first' => $primary === null,
                    'kept_previous_as_failover' => $demoteFailover];
            });
        } catch (UniqueConstraintViolationException) {
            throw new ApiException(409, 'invalid_state_transition', 'Another change to the SMS providers just happened. Reload and try again.');
        }
        self::query()->whereKey($target->id)->update(['activated_by' => $by->id]);
        SmsRoutingTable::flush();
        foreach (array_filter([$target->id, $meta['previous_primary_id'] ?? null, $meta['previous_failover_id'] ?? null]) as $id) {
            $this->breaker->reset($id);
        }
        $this->audit->log('sms_provider.activated', $target, $meta, $by, tenantId: false, platform: true);
    }

    /**
     * P89B-5 / S223: test the NEW credentials (synchronous); only a passing test swaps them in, atomically.
     *
     * @param  array<string, mixed>|null  $settings  account_id / base_url
     */
    public function rotate(SmsProvider $provider, #[SensitiveParameter] mixed $credentials, ?array $settings, string $phone, User $by): SmsProvider
    {
        $msisdn = self::phone($phone);
        $new = SmsProviderRules::credentials($provider->driver, $credentials);
        $changes = is_array($settings) ? array_intersect_key($settings, array_flip(['account_id', 'base_url'])) : [];
        $merged = SmsProviderRules::settings($provider->driver, $changes, (array) $provider->settings, array_keys($new));
        $connection = SmsDriverFactory::connect($new, $merged, (int) $provider->failover_timeout_seconds, $provider->id);
        $result = $this->sendTest($provider->driver, $connection, $provider->name, $provider->default_sender_id, $msisdn, $provider->id);
        $meta = ['credential_fields' => array_keys($new), 'credentials_hint' => SmsProviderRules::hints($new), 'to_masked' => $result['to_masked']];
        if ($result['status'] !== SmsProvider::PASSED) {
            $this->audit->log('sms_provider.rotation_failed', $provider, $meta + ['error_code' => $result['error_code']], $by, tenantId: false, platform: true);

            throw new ApiException(422, 'sms_provider_test_failed', 'The test SMS with the new credentials failed. The old credentials keep working.',
                ['error_code' => $result['error_code'], 'detail' => $result['detail']]);
        }
        PlatformDb::connection()->transaction(function () use ($provider, $new, $merged, $by) {
            $row = self::query()->whereKey($provider->id)->lockForUpdate()->first() ?? throw new ApiException(404, 'not_found', 'Resource not found.');
            $now = now();
            self::query()->whereKey($row->id)->update([
                'credentials_encrypted' => $this->crypto->encrypt($new), 'credentials_hint' => json_encode(SmsProviderRules::hints($new)),
                'settings' => json_encode($merged), 'credentials_rotated_at' => $now, 'credentials_rotated_by' => $by->id,
                'connection_changed_at' => $now, 'last_test_at' => $now, 'last_test_status' => SmsProvider::PASSED, 'last_test_error_code' => null,
                'last_test_by' => $by->id, 'revision' => $row->revision + 1, 'updated_at' => $now,
            ]);
        });
        $this->breaker->reset($provider->id);
        SmsRoutingTable::flush();
        $this->audit->log('sms_provider.credentials_rotated', $provider, $meta, $by, tenantId: false, platform: true);

        return self::locate($provider->id);
    }

    /** P89B-7: failover, draft or inactive only; typed name; credentials wiped, row kept for history. */
    public function remove(SmsProvider $provider, ?string $confirmName, User $by): void
    {
        PlatformDb::connection()->transaction(function () use ($provider, $confirmName, $by) {
            self::query()->where('role', '<>', SmsProvider::REMOVED)->orderBy('id')->lockForUpdate()->get();
            $row = self::query()->whereKey($provider->id)->where('role', '<>', SmsProvider::REMOVED)->first()
                ?? throw new ApiException(404, 'not_found', 'Resource not found.');
            if ($row->role === SmsProvider::PRIMARY) {
                throw new ApiException(409, 'sms_provider_is_primary', 'The primary provider can’t be removed. Activate another primary first.');
            }
            self::assertName($row, $confirmName);
            self::query()->whereKey($row->id)->update([
                'role' => SmsProvider::REMOVED, 'credentials_encrypted' => null, 'credentials_hint' => '{}', 'removed_at' => now(),
                'removed_by' => $by->id, 'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
        });
        $this->breaker->reset($provider->id);
        SmsRoutingTable::flush();
        $this->audit->log('sms_provider.removed', $provider, ['role' => $provider->role, 'name' => $provider->name], $by, tenantId: false, platform: true);
    }

    public function refreshBalance(SmsProvider $provider): SmsProvider
    {
        $this->balances->refresh($provider);

        return self::locate($provider->id);
    }

    /**
     * One synchronous test send through a driver; writes a `platform_test` row (tenant NULL).
     *
     * @return array{status: string, latency_ms: int|null, parts: int, provider_message_id: string|null, balance_paisa: int|null, error_code: string|null, detail: string|null, to_masked: string}
     */
    public function sendTest(string $driver, SmsConnection $connection, string $name, string $sender, string $msisdn, ?string $providerId): array
    {
        $text = 'Store Plix SMS test from '.Str::limit(PlatformSmsTemplates::render('{store_name}', ['store_name' => $name]), 40, '').'. No action needed.';
        $parts = PlatformSmsTemplates::count($text)['parts'];
        $message = PlatformSmsDelivery::query()->create([
            'tenant_id' => null, 'to' => $msisdn, 'purpose' => PlatformSmsType::TEST_PURPOSE, 'template' => 'platform:provider_test',
            'status' => SmsMessage::QUEUED, 'parts' => $parts, 'body_preview' => SmsPreview::of(PlatformSmsType::TEST_PURPOSE, $text), 'provider_id' => $providerId,
        ]);
        $started = microtime(true);
        try {
            $result = $this->factory->driver($driver)->send($connection, $msisdn, $text, $sender);
        } catch (SmsSendFailed $e) {
            $e = $e->withProvider($providerId);
            PlatformSmsDelivery::markFailed($message->id, $e);

            return ['status' => SmsProvider::FAILED, 'latency_ms' => (int) ((microtime(true) - $started) * 1000), 'parts' => $parts,
                'provider_message_id' => null, 'balance_paisa' => null, 'error_code' => $e->errorCode(),
                'detail' => $connection->redact(Str::limit((string) ($e->detail ?? $e->getMessage()), 200)), 'to_masked' => SmsPreview::maskPhone($msisdn)];
        }
        $latency = (int) ((microtime(true) - $started) * 1000);
        PlatformSmsDelivery::markSent($message->id, $result->withRoute($providerId, $latency));

        return ['status' => SmsProvider::PASSED, 'latency_ms' => $latency, 'parts' => $parts, 'provider_message_id' => $result->message_id,
            'balance_paisa' => null, 'error_code' => null, 'detail' => null, 'to_masked' => SmsPreview::maskPhone($msisdn)];
    }

    /** P89B-26: any BD mobile, normalised. */
    public static function phone(string $phone): string
    {
        return Phone::bdMsisdn($phone) ?? throw ValidationException::withMessages(['phone' => ['Enter a Bangladeshi mobile number.']]);
    }

    /** @param array<string, mixed> $input @return array<string, mixed> the plain (non-connection) columns present in the input */
    private static function plain(array $input): array
    {
        return array_intersect_key($input, array_flip(['default_sender_id', 'promotional_sender_id', 'promotional_sender_status', 'rate_limit_per_minute',
            'failover_after_failures', 'failover_timeout_seconds', 'price_masking_paisa', 'price_non_masking_paisa', 'low_threshold_paisa',
            'alert_email', 'alert_in_app']));
    }

    private static function assertName(SmsProvider $p, ?string $confirmName): void
    {
        if (mb_strtolower(trim((string) $confirmName)) !== mb_strtolower(trim($p->name))) {
            throw new ApiException(422, 'confirmation_mismatch', 'Type the provider name exactly to confirm.');
        }
    }

    private function assertNameFree(string $name, ?string $except): void
    {
        $taken = self::query()->where('role', '<>', SmsProvider::REMOVED)->whereRaw('lower(name) = ?', [mb_strtolower($name)])
            ->when($except !== null, fn ($q) => $q->whereKeyNot($except))->exists();
        if ($taken) {
            throw self::nameTaken();
        }
    }

    private static function nameTaken(): ApiException
    {
        return new ApiException(409, 'sms_provider_name_taken', 'Another provider already has this name.');
    }
}
