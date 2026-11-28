<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Platform\PlatformSmsMessageTypes;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\SmsPreview;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Collection;

/** PHASE-8-9B openapi 1.24.0 PlatformSmsBroadcast, PlatformSmsBroadcastRecipient and the list KPIs. */
final class BroadcastPresenter
{
    /** @param iterable<PlatformSmsBroadcast> $rows @return list<array<string, mixed>> */
    public static function many(iterable $rows): array
    {
        $rows = collect($rows);
        $users = User::query()->whereIn('id', $rows->flatMap(fn (PlatformSmsBroadcast $b) => [$b->created_by, $b->confirmed_by])->filter()->unique()->all())
            ->get(['id', 'name'])->keyBy('id');
        $pending = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->whereIn('broadcast_id', $rows->pluck('id')->all())
            ->where('status', PlatformSmsBroadcastRecipient::PENDING)->selectRaw('broadcast_id, count(*) as c')->groupBy('broadcast_id')->pluck('c', 'broadcast_id');
        $ref = fn (?string $id) => $id !== null && $users->has($id) ? ['id' => $id, 'name' => (string) $users[$id]->name] : null;

        return $rows->map(fn (PlatformSmsBroadcast $b) => [
            'id' => $b->id,
            'name' => $b->name,
            'body_bn' => $b->body_bn,
            'body_en' => $b->body_en,
            'audience' => $b->audience,
            'status' => $b->status,
            'scheduled_at' => $b->scheduled_at?->toIso8601ZuluString(),
            'started_at' => $b->started_at?->toIso8601ZuluString(),
            'finished_at' => $b->finished_at?->toIso8601ZuluString(),
            'estimate' => $b->estimate,
            'counts' => ['recipients' => $b->recipients_count, 'sent' => $b->sent_count, 'failed' => $b->failed_count,
                'skipped' => $b->skipped_count, 'pending' => (int) ($pending[$b->id] ?? 0)],
            'created_by' => $ref($b->created_by),
            'confirmed_by' => $ref($b->confirmed_by),
            'confirmed_at' => $b->confirmed_at?->toIso8601ZuluString(),
            'cancelled_at' => $b->cancelled_at?->toIso8601ZuluString(),
            'failure_reason' => $b->failure_reason,
            'revision' => $b->revision,
            'created_at' => $b->created_at->toIso8601ZuluString(),
        ])->values()->all();
    }

    /** @return array<string, mixed> */
    public static function one(PlatformSmsBroadcast $b): array
    {
        return self::many([$b])[0];
    }

    /** @param Collection<int, object> $rows @return list<array<string, mixed>> */
    public static function recipients(Collection $rows): array
    {
        $shops = AdminPresenter::shopRefs($rows->pluck('tenant_id')->map(fn ($v) => (string) $v)->all());

        return $rows->map(fn ($r) => [
            'id' => (string) $r->id,
            'tenant' => $shops[(string) $r->tenant_id] ?? ['id' => (string) $r->tenant_id, 'name' => '', 'slug' => ''],
            'to_masked' => $r->to !== null ? SmsPreview::maskPhone((string) $r->to) : null,
            'language' => (string) $r->language,
            'status' => (string) $r->status,
            'skip_reason' => $r->skip_reason,
            'parts' => $r->parts !== null ? (int) $r->parts : null,
            'sent_at' => AdminPresenter::ts($r->sent_at),
        ])->values()->all();
    }

    /** @return array{broadcasts_this_month: int, sent_success_rate: float|null, opted_out_total: int, spend_this_month_paisa: int} */
    public static function kpis(): array
    {
        $start = PlatformSmsMessageTypes::monthStart();
        $db = PlatformDb::connection(); // cross-tenant: platform SMS broadcast KPIs
        $recipients = $db->table('platform_sms_broadcast_recipients')->where('created_at', '>=', $start)
            ->whereIn('status', [PlatformSmsBroadcastRecipient::SENT, PlatformSmsBroadcastRecipient::FAILED])
            ->selectRaw('status, count(*) as c')->groupBy('status')->pluck('c', 'status');
        $sent = (int) ($recipients[PlatformSmsBroadcastRecipient::SENT] ?? 0);
        $failed = (int) ($recipients[PlatformSmsBroadcastRecipient::FAILED] ?? 0);
        $parts = $db->table('sms_messages')->whereNull('tenant_id')->where('purpose', PlatformSmsType::Broadcast->purpose())
            ->where('status', SmsMessage::SENT)->where('created_at', '>=', $start)->selectRaw('provider_id, sum(parts) as p')->groupBy('provider_id')->pluck('p', 'provider_id');
        $prices = SmsProvider::query()->whereIn('id', $parts->keys()->filter()->all())->pluck('price_masking_paisa', 'id');
        $spend = 0;
        foreach ($parts as $id => $p) {
            $spend += (int) $p * (int) ($prices[$id] ?? 0);
        }

        return [
            'broadcasts_this_month' => BroadcastService::query()->whereIn('status', [PlatformSmsBroadcast::SENDING, PlatformSmsBroadcast::SENT])
                ->where('started_at', '>=', $start)->count(),
            'sent_success_rate' => $sent + $failed > 0 ? round($sent * 100 / ($sent + $failed), 1) : null,
            'opted_out_total' => $db->table('users')->whereNotNull('platform_promo_sms_opted_out_at')->count(),
            'spend_this_month_paisa' => $spend,
        ];
    }
}
