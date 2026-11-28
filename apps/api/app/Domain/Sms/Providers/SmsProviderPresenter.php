<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Identity\Models\User;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\Routing\SmsBreaker;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B openapi 1.24.0 shapes: SmsProvider (never a credential: `credentials_hint` only, S220),
 * SmsProviderOverview (source, primary, failover, others, environment, waiting, recent errors, alerts) and the
 * PlatformSmsAlert list. Statistics read `sms_messages` across tenants on the platform connection
 * (`// cross-tenant: platform SMS provider statistics`).
 */
final class SmsProviderPresenter
{
    public function __construct(
        private readonly SmsBreaker $breaker,
        private readonly SmsRoutingTable $table,
    ) {}

    /** @return array<string, mixed> SmsProvider */
    public function provider(SmsProvider $p): array
    {
        $db = PlatformDb::connection(); // cross-tenant: platform SMS provider statistics
        $since24 = now()->subDay();
        $counts = $db->table('sms_messages')->where('provider_id', $p->id)->where('created_at', '>=', $since24)
            ->whereIn('status', [SmsMessage::SENT, SmsMessage::FAILED])->selectRaw('status, count(*) as c')->groupBy('status')->pluck('c', 'status');
        $sent = (int) ($counts[SmsMessage::SENT] ?? 0);
        $failed = (int) ($counts[SmsMessage::FAILED] ?? 0);
        $parts7 = (int) $db->table('sms_messages')->where('provider_id', $p->id)->where('status', SmsMessage::SENT)
            ->where('created_at', '>=', now()->subDays(7))->sum('parts');
        $lastSent = $db->table('sms_messages')->where('provider_id', $p->id)->where('status', SmsMessage::SENT)->max('sent_at');
        $price = $p->price_masking_paisa;
        $spend7 = $price !== null ? $parts7 * $price : 0;
        $status = match (true) {
            $p->balance_status === null => 'unknown',
            $p->balance_status === 'ok' && $p->balance_amount !== null && $p->low_threshold_paisa !== null && $p->balance_amount < $p->low_threshold_paisa => 'low',
            default => $p->balance_status,
        };
        $users = User::query()->whereIn('id', array_filter([$p->last_test_by, $p->credentials_rotated_by]))->get(['id', 'name'])->keyBy('id');
        $ref = fn (?string $id) => $id !== null && $users->has($id) ? ['id' => $id, 'name' => (string) $users[$id]->name] : null;
        $settings = (array) $p->settings;

        return [
            'id' => $p->id,
            'driver' => $p->driver,
            'name' => $p->name,
            'role' => $p->role,
            'credentials_hint' => (object) ((array) $p->credentials_hint),
            'settings' => ['account_id' => $settings['account_id'] ?? null, 'base_url' => (string) ($settings['base_url'] ?? ''), 'http' => $settings['http'] ?? null],
            'default_sender_id' => $p->default_sender_id,
            'promotional_sender_id' => $p->promotional_sender_id,
            'promotional_sender_status' => $p->promotional_sender_status,
            'message_groups' => array_values((array) $p->message_groups),
            'rate_limit_per_minute' => $p->rate_limit_per_minute,
            'failover_after_failures' => $p->failover_after_failures,
            'failover_timeout_seconds' => $p->failover_timeout_seconds,
            'price_masking_paisa' => $p->price_masking_paisa,
            'price_non_masking_paisa' => $p->price_non_masking_paisa,
            'balance' => [
                'status' => $status,
                'amount_paisa' => $p->balance_amount,
                'currency' => 'BDT',
                'fetched_at' => $p->balance_fetched_at?->toIso8601ZuluString(),
                'approx_parts' => $p->balance_amount !== null && $price ? intdiv($p->balance_amount, $price) : null,
                'days_left' => $p->balance_amount !== null && $spend7 > 0 ? intdiv($p->balance_amount * 7, $spend7) : null,
                'spend_7d_paisa' => $spend7,
                'low_threshold_paisa' => $p->low_threshold_paisa,
                'alert_email' => $p->alert_email,
                'alert_in_app' => $p->alert_in_app,
            ],
            'health' => $this->health($p, $lastSent),
            'accepted_rate_24h' => $sent + $failed > 0 ? round($sent * 100 / ($sent + $failed), 1) : null,
            'last_sent_at' => $lastSent !== null ? Carbon::parse($lastSent)->utc()->toIso8601ZuluString() : null,
            'last_test' => $p->last_test_at !== null && $p->last_test_status !== null ? [
                'at' => $p->last_test_at->toIso8601ZuluString(), 'status' => $p->last_test_status,
                'error_code' => $p->last_test_error_code, 'by' => $ref($p->last_test_by),
            ] : null,
            'test_required' => $p->testRequired(),
            'credentials_rotated_at' => $p->credentials_rotated_at?->toIso8601ZuluString(),
            'credentials_rotated_by' => $ref($p->credentials_rotated_by),
            'activated_at' => $p->activated_at?->toIso8601ZuluString(),
            'created_at' => $p->created_at->toIso8601ZuluString(),
            'revision' => $p->revision,
        ];
    }

    /** @return array<string, mixed> SmsProviderOverview */
    public function overview(): array
    {
        $rows = SmsProviderService::query()->where('role', '<>', SmsProvider::REMOVED)->orderBy('created_at')->get();
        $primary = $rows->firstWhere('role', SmsProvider::PRIMARY);
        $failover = $rows->firstWhere('role', SmsProvider::FAILOVER);
        $others = $rows->filter(fn (SmsProvider $p) => in_array($p->role, [SmsProvider::DRAFT, SmsProvider::INACTIVE], true))->values();
        $source = $this->table->source();
        $env = (array) config('sms.revesms', []);
        $driver = (string) config('sms.driver');

        return [
            'source' => $source,
            'primary' => $primary !== null ? $this->provider($primary) : null,
            'failover' => $failover !== null ? $this->provider($failover) : null,
            'others' => $others->map(fn (SmsProvider $p) => $this->provider($p))->all(),
            'environment' => $primary === null ? [
                'driver' => in_array($driver, ['revesms', 'log', 'fake'], true) ? $driver : 'log',
                'caller_id' => ($env['caller_id'] ?? null) !== null && $env['caller_id'] !== '' ? (string) $env['caller_id'] : null,
                'credentials_hint' => (object) array_map(fn ($v) => IntegrationCredentials::hint((string) $v),
                    array_filter(['api_key' => $env['api_key'] ?? null, 'secret_key' => $env['secret_key'] ?? null], fn ($v) => (string) $v !== '')),
            ] : null,
            'failover_active' => $this->failoverActive($primary, $failover),
            'waiting' => $this->waiting(),
            'recent_errors' => $this->recentErrors(),
            'alerts' => $this->alerts(),
        ];
    }

    private function failoverActive(?SmsProvider $primary, ?SmsProvider $failover): bool
    {
        $primaryId = $primary?->id;

        return $failover !== null && ($primary !== null || SmsRoutingTable::environmentAvailable()) && $this->breaker->isOpen($primaryId);
    }

    /** Group of an `sms_messages` row from its purpose and tenant. */
    public static function groupOf(?string $tenantId, string $purpose): ?string
    {
        if ($tenantId !== null) {
            return 'shop';
        }

        return PlatformSmsType::fromPurpose($purpose)?->group();
    }

    /** @return list<array{group: string, queued: int, failed_24h: int}> */
    private function waiting(): array
    {
        $db = PlatformDb::connection(); // cross-tenant: platform SMS provider statistics
        $rows = $db->table('sms_messages')->where('created_at', '>=', now()->subDay())->whereIn('status', [SmsMessage::QUEUED, SmsMessage::FAILED])
            ->selectRaw('CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END as shop, purpose, status, count(*) as c')
            ->groupByRaw('CASE WHEN tenant_id IS NULL THEN 0 ELSE 1 END, purpose, status')->get();
        $out = [];
        foreach (['shop', 'registration', 'billing', 'security', 'promotional'] as $g) {
            $out[$g] = ['group' => $g, 'queued' => 0, 'failed_24h' => 0];
        }
        foreach ($rows as $r) {
            $group = (int) $r->shop === 1 ? 'shop' : PlatformSmsType::fromPurpose((string) $r->purpose)?->group();
            if ($group === null) {
                continue;
            }
            $out[$group][$r->status === SmsMessage::QUEUED ? 'queued' : 'failed_24h'] += (int) $r->c;
        }

        return array_values($out);
    }

    /** P89B-27: the last 20 failed / failed-over / retrying SMS of 24 h (any group), provider text redacted (≤ 200). @return list<array<string, mixed>> */
    private function recentErrors(): array
    {
        $db = PlatformDb::connection(); // cross-tenant: platform SMS provider statistics
        $rows = $db->table('sms_messages')->where('created_at', '>=', now()->subDay())->whereNotNull('error_code')
            ->whereNotIn('error_code', [SmsMessage::NO_CREDITS])
            ->orderByDesc('created_at')->orderByDesc('id')->limit(20)
            ->get(['id', 'tenant_id', 'purpose', 'status', 'to', 'error_code', 'error', 'provider_id', 'created_at', 'updated_at']);
        $names = SmsProviderService::query()->whereIn('id', $rows->pluck('provider_id')->filter()->unique()->all())->pluck('name', 'id');

        return $rows->map(function ($r) use ($names) {
            $type = $r->tenant_id !== null ? 'shop' : ($r->purpose === PlatformSmsType::TEST_PURPOSE ? 'test' : (PlatformSmsType::fromPurpose((string) $r->purpose)?->value ?? 'shop'));
            $code = in_array($r->error_code, [SmsSendFailed::PROVIDER_ERROR, SmsSendFailed::PROVIDER_UNAVAILABLE, SmsSendFailed::PROVIDER_TIMEOUT,
                SmsSendFailed::PROVIDER_AUTH, SmsSendFailed::NO_ROUTE], true) ? $r->error_code : SmsSendFailed::PROVIDER_ERROR;

            return [
                'id' => (string) $r->id,
                'at' => Carbon::parse($r->updated_at ?? $r->created_at)->utc()->toIso8601ZuluString(),
                'provider' => $r->provider_id !== null && $names->has($r->provider_id) ? ['id' => (string) $r->provider_id, 'name' => (string) $names[$r->provider_id]] : null,
                'error_code' => $code,
                'detail' => $r->error !== null ? mb_substr((string) $r->error, 0, 200) : null,
                'type' => $type,
                'to_masked' => SmsPreview::maskPhone((string) $r->to),
                'result' => match ($r->status) {
                    SmsMessage::SENT => 'failed_over',
                    SmsMessage::QUEUED => 'retrying',
                    default => 'failed',
                },
            ];
        })->values()->all();
    }

    /** §4.7 PlatformSmsAlert list, most severe first. @return list<array{code: string, severity: string, message: string, provider_id: string|null}> */
    public function alerts(): array
    {
        $out = [];
        $source = $this->table->source();
        if ($source === 'none') {
            $out[] = ['code' => 'no_provider', 'severity' => 'danger', 'message' => 'No SMS provider — sign-in codes will fail', 'provider_id' => null];
        }
        $rows = SmsProviderService::query()->whereIn('role', [SmsProvider::PRIMARY, SmsProvider::FAILOVER])->orderBy('role')->get();
        $primary = $rows->firstWhere('role', SmsProvider::PRIMARY);
        $failover = $rows->firstWhere('role', SmsProvider::FAILOVER);
        if ($this->failoverActive($primary, $failover)) {
            $out[] = ['code' => 'failover_active', 'severity' => 'warning',
                'message' => ($primary?->name ?? 'The primary provider').' is failing — SMS go through '.$failover->name.'.', 'provider_id' => $primary?->id];
        }
        foreach ($rows as $p) {
            if ($p->alert_in_app && $p->balance_status === 'ok' && $p->balance_amount !== null && $p->low_threshold_paisa !== null && $p->balance_amount < $p->low_threshold_paisa) {
                $out[] = ['code' => 'low_balance', 'severity' => 'warning', 'message' => "{$p->name} balance is low.", 'provider_id' => $p->id];
            }
        }
        foreach ($rows as $p) {
            if ($p->balance_status === 'error' && $p->balance_failures >= 2) {
                $out[] = ['code' => 'balance_unavailable', 'severity' => 'info', 'message' => "{$p->name} balance couldn’t be read.", 'provider_id' => $p->id];
            }
        }
        $promo = $rows->first(fn (SmsProvider $p) => $p->carries('promotional'));
        if ($promo !== null && ($promo->promotional_sender_id === null || $promo->promotional_sender_status !== 'approved')) {
            $out[] = ['code' => 'promotional_paused', 'severity' => 'info', 'message' => 'Promotional SMS are paused until the promotional sender ID is approved.', 'provider_id' => $promo->id];
        }

        return $out;
    }

    /** Breaker state (cache) first; when it has no record (fresh cache, env-driver sends) a recorded send still counts as healthy. */
    private function health(SmsProvider $p, mixed $lastSent): string
    {
        if (! in_array($p->role, [SmsProvider::PRIMARY, SmsProvider::FAILOVER], true)) {
            return 'unknown';
        }
        $health = $this->breaker->health($p->id);

        return $health === 'unknown' && $lastSent !== null ? 'healthy' : $health;
    }
}
