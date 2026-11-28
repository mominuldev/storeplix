<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * PHASE-8-9B §8 (P89B-24, S230): platform-sent SMS only (`tenant_id IS NULL`), never shop SMS. 90 days (Asia/Dhaka),
 * newest first; filters q (an exact BD phone, else the merchant's store name ≥ 2), status, group, dates. Phones masked,
 * code bodies never stored nor shown (`body_hidden`), previews nulled after 90 days. Platform connection
 * (`// cross-tenant: platform SMS log`).
 */
final class PlatformSmsLog
{
    public const PER_PAGE = 50;

    /** @param array<string, string> $filter validated @return Builder<SmsMessage> */
    public static function query(array $filter): Builder
    {
        $tz = (string) config('sms.platform.timezone', 'Asia/Dhaka');
        $windowStart = now($tz)->subDays((int) config('sms.log_days', 90))->startOfDay()->utc();
        $from = isset($filter['from']) ? Carbon::createFromFormat('Y-m-d', $filter['from'], $tz)->startOfDay()->utc() : null;
        $to = isset($filter['to']) ? Carbon::createFromFormat('Y-m-d', $filter['to'], $tz)->endOfDay()->utc() : null;
        $query = PlatformDb::reroute(SmsMessage::query())->whereNull('tenant_id') // cross-tenant: platform SMS log
            ->where('created_at', '>=', $from !== null && $from->gt($windowStart) ? $from : $windowStart)
            ->when($to !== null, fn ($q) => $q->where('created_at', '<=', $to))
            ->when(isset($filter['status']), fn ($q) => $q->whereIn('status', explode(',', $filter['status'])));
        if (isset($filter['group'])) {
            $purposes = [];
            foreach (PlatformSmsType::cases() as $type) {
                if (in_array($type->group(), explode(',', $filter['group']), true)) {
                    $purposes[] = $type->purpose();
                }
            }
            $query->whereIn('purpose', $purposes);
        }
        if (isset($filter['q']) && ($q = trim($filter['q'])) !== '') {
            $msisdn = Phone::bdMsisdn($q);
            if ($msisdn !== null) {
                $query->where('to', $msisdn);
            } else {
                $term = '%'.str_replace(['%', '_', '\\'], '', mb_strtolower($q)).'%';
                $tenants = PlatformDb::connection()->table('stores')->whereRaw('lower(name) like ?', [$term])->pluck('tenant_id')
                    ->merge(PlatformDb::connection()->table('tenants')->whereRaw('lower(name) like ?', [$term])->pluck('id'))->unique()->values()->all();
                $query->whereIn('merchant_tenant_id', $tenants);
            }
        }

        return $query->orderByDesc('created_at')->orderByDesc('id');
    }

    /** @param Collection<int, SmsMessage> $rows @return list<array<string, mixed>> PlatformSmsLogEntry */
    public static function present(Collection $rows): array
    {
        $shops = AdminPresenter::shopRefs($rows->pluck('merchant_tenant_id')->filter()->map(fn ($v) => (string) $v)->all());
        $names = SmsProvider::query()->whereIn('id', $rows->pluck('provider_id')->filter()->unique()->all())->pluck('name', 'id');
        $previewSince = now()->subDays((int) config('sms.preview_days', 90));
        $env = match ((string) config('sms.driver')) {
            'log' => 'Log driver (development)', 'fake' => 'Fake driver (tests)', default => 'REVE SMS (server environment)',
        };

        return $rows->map(function (SmsMessage $m) use ($shops, $names, $previewSince, $env) {
            $type = PlatformSmsType::fromPurpose($m->purpose);
            $hidden = str_starts_with($m->purpose, 'otp_') || ($m->purpose === PlatformSmsType::TEST_PURPOSE && $m->body_preview === null);
            $known = [SmsSendFailed::PROVIDER_ERROR, SmsSendFailed::PROVIDER_UNAVAILABLE, SmsSendFailed::PROVIDER_TIMEOUT, SmsSendFailed::PROVIDER_AUTH, SmsSendFailed::NO_ROUTE];
            $error = match (true) {
                $m->status === SmsMessage::SENT => null,
                $m->error_code !== null => in_array($m->error_code, $known, true) ? $m->error_code : SmsSendFailed::PROVIDER_ERROR,
                $m->status === SmsMessage::FAILED => SmsSendFailed::PROVIDER_ERROR,
                default => null,
            };

            return [
                'id' => $m->id,
                'created_at' => $m->created_at->toIso8601ZuluString(),
                'to_masked' => SmsPreview::maskPhone($m->to),
                'merchant' => $m->merchant_tenant_id !== null ? ($shops[$m->merchant_tenant_id] ?? null) : null,
                'type' => $type?->value ?? 'test',
                'group' => $type?->group(),
                'status' => $m->status,
                'body_preview' => $hidden || $m->created_at->lt($previewSince) ? null : $m->body_preview,
                'body_hidden' => $hidden,
                'parts' => $m->parts,
                'provider' => in_array($m->status, [SmsMessage::SENT, SmsMessage::FAILED], true) || $m->provider_id !== null
                    ? ($m->provider_id !== null ? ($names->has($m->provider_id) ? ['id' => $m->provider_id, 'name' => (string) $names[$m->provider_id]] : null) : ['id' => null, 'name' => $env])
                    : null,
                'error_code' => $error,
            ];
        })->values()->all();
    }

    /** CSV columns (§8). @return list<string> */
    public static function csvHeader(): array
    {
        return ['time (Asia/Dhaka)', 'phone (masked)', 'merchant', 'type', 'group', 'message', 'parts', 'status', 'provider', 'error'];
    }

    /** @param array<string, mixed> $e PlatformSmsLogEntry @return list<string> */
    public static function csvRow(array $e): array
    {
        $cell = fn (?string $v) => $v !== null && preg_match('/^[=+\-@\t\r]/', $v) === 1 ? "'".$v : (string) $v; // CSV injection guard

        return [
            Carbon::parse($e['created_at'])->timezone((string) config('sms.platform.timezone', 'Asia/Dhaka'))->format('Y-m-d H:i'),
            $e['to_masked'],
            $cell($e['merchant']['name'] ?? ''),
            $e['type'],
            (string) ($e['group'] ?? ''),
            $e['body_hidden'] ? 'Code hidden' : $cell($e['body_preview'] ?? ''),
            (string) ($e['parts'] ?? ''),
            $e['status'],
            $cell($e['provider']['name'] ?? ''),
            (string) ($e['error_code'] ?? ''),
        ];
    }
}
