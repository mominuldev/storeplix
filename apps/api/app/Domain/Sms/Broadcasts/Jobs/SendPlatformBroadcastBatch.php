<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts\Jobs;

use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Broadcasts\BroadcastService;
use App\Domain\Sms\Broadcasts\BroadcastTexts;
use App\Domain\Sms\Broadcasts\SendingHours;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Platform\PlatformSmsDelivery;
use App\Domain\Sms\Platform\PlatformSmsTemplates;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\Routing\RoutingSmsGateway;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * PHASE-8-9B P89B-22: sends up to 100 pending recipients of a `sending` broadcast. Per recipient (P85-8 / S228) it
 * re-checks suspension, the verified phone, the opt-out and the weekly cap, claims the row (so a duplicate batch can't send
 * it twice), renders the bn/en text + a fresh STOP link (code stored as sha256 only), sends through the `promotional`
 * route paced by the provider's rate limit, and writes the `sms_messages` row. Outside 09:00–21:00 Dhaka it stops
 * (`sms:run-broadcasts` resumes it). A route that stays unavailable for 30 minutes fails the rest.
 */
class SendPlatformBroadcastBatch implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public readonly string $broadcastId, public readonly int $attempt = 0)
    {
        $this->onQueue('notifications');
    }

    public function handle(SmsGateway $gateway): void
    {
        $broadcast = BroadcastService::query()->whereKey($this->broadcastId)->first();
        if ($broadcast === null || $broadcast->status !== PlatformSmsBroadcast::SENDING || ! SendingHours::open()) {
            return; // paused outside sending hours; sms:run-broadcasts resumes it at 09:00
        }
        $db = PlatformDb::connection();
        $recipients = $db->table('platform_sms_broadcast_recipients')->where('broadcast_id', $broadcast->id)
            ->where('status', PlatformSmsBroadcastRecipient::PENDING)->whereNull('sms_message_id')
            ->orderBy('id')->limit((int) config('sms.platform.broadcast_batch', 100))->get();
        $users = $db->table('users')->whereIn('id', $recipients->pluck('user_id')->filter()->all())
            ->get(['id', 'name', 'phone', 'phone_verified_at', 'platform_promo_sms_opted_out_at'])->keyBy('id');
        $tenants = $db->table('tenants')->whereIn('id', $recipients->pluck('tenant_id')->all())->pluck('status', 'id');
        $stores = $db->table('stores')->whereIn('tenant_id', $recipients->pluck('tenant_id')->all())->pluck('name', 'tenant_id');
        $plans = $db->table('subscriptions as s')->join('plans as p', 'p.id', '=', 's.plan_id')->whereIn('s.tenant_id', $recipients->pluck('tenant_id')->all())
            ->orderBy('s.created_at')->pluck('p.name', 's.tenant_id');
        $router = $gateway instanceof RoutingSmsGateway ? $gateway : null;

        foreach ($recipients as $r) {
            if (! SendingHours::open()) {
                break; // 21:00: pause
            }
            $user = $r->user_id !== null ? $users->get($r->user_id) : null;
            $msisdn = $user !== null && $user->phone_verified_at !== null ? Phone::bdMsisdn($user->phone) : null;
            $reason = match (true) {
                ($tenants[$r->tenant_id] ?? null) === Tenant::STATUS_SUSPENDED => 'suspended',
                $msisdn === null => 'no_verified_phone',
                $user->platform_promo_sms_opted_out_at !== null => 'opted_out',
                $this->overCap($r->tenant_id, $broadcast->id) => 'weekly_cap',
                default => null,
            };
            if ($reason !== null) {
                $db->table('platform_sms_broadcast_recipients')->where('id', $r->id)->where('status', PlatformSmsBroadcastRecipient::PENDING)
                    ->update(['status' => PlatformSmsBroadcastRecipient::SKIPPED, 'skip_reason' => $reason, 'to' => null, 'updated_at' => now()]);

                continue;
            }
            if ($router !== null) {
                $slot = $router->promotionalSlot();
                if ($slot['route'] !== null && $slot['wait'] > 0) {
                    self::dispatch($broadcast->id, $this->attempt)->delay(now()->addSeconds($slot['wait']));

                    return; // P89B-28: broadcasts wait for the rate limit; codes never do
                }
            }
            // Claim the recipient (a duplicate batch can't send it twice).
            $messageId = Str::lower((string) Str::ulid());
            $claimed = $db->table('platform_sms_broadcast_recipients')->where('id', $r->id)->where('status', PlatformSmsBroadcastRecipient::PENDING)
                ->whereNull('sms_message_id')->update(['sms_message_id' => $messageId, 'updated_at' => now()]);
            if ($claimed !== 1) {
                continue;
            }
            $code = BroadcastTexts::newCode();
            $body = $r->language === 'en' ? $broadcast->body_en : $broadcast->body_bn;
            $text = BroadcastTexts::text($body, $r->language, [
                'merchant_name' => (string) $user->name, 'store_name' => (string) ($stores[$r->tenant_id] ?? 'your shop'),
                'plan' => (string) ($plans[$r->tenant_id] ?? ''),
            ], $code);
            $parts = PlatformSmsTemplates::count($text)['parts'];
            $message = PlatformSmsDelivery::create([
                'id' => $messageId, 'tenant_id' => null, 'merchant_tenant_id' => $r->tenant_id, 'to' => $msisdn,
                'purpose' => PlatformSmsType::Broadcast->purpose(), 'template' => 'platform:broadcast.'.$r->language,
                'status' => SmsMessage::QUEUED, 'platform_type' => PlatformSmsType::Broadcast->value, 'parts' => $parts,
                'body_preview' => SmsPreview::of(PlatformSmsType::Broadcast->purpose(), $text),
            ]);
            try {
                $result = $gateway->send($msisdn, $text, null, SmsRoute::Promotional);
            } catch (SmsSendFailed $e) {
                if ($e->providerLevel()) {
                    // Nothing was accepted: release the claim, retry the batch later within the window.
                    PlatformSmsDelivery::query()->whereKey($message->id)->delete();
                    $db->table('platform_sms_broadcast_recipients')->where('id', $r->id)->update(['sms_message_id' => null, 'updated_at' => now()]);
                    $this->retryOrFail($broadcast, $e);

                    return;
                }
                PlatformSmsDelivery::markFailed($message->id, $e);
                $db->table('platform_sms_broadcast_recipients')->where('id', $r->id)
                    ->update(['status' => PlatformSmsBroadcastRecipient::FAILED, 'parts' => $parts, 'to' => $msisdn, 'updated_at' => now()]);

                continue;
            }
            PlatformSmsDelivery::markSent($message->id, $result);
            $db->table('platform_sms_broadcast_recipients')->where('id', $r->id)->update([
                'status' => PlatformSmsBroadcastRecipient::SENT, 'parts' => $parts, 'to' => $msisdn, 'sent_at' => now(),
                'opt_out_code_hash' => hash('sha256', $code), 'updated_at' => now(),
            ]);
        }

        self::refreshCounts($broadcast->id);
        $pending = $db->table('platform_sms_broadcast_recipients')->where('broadcast_id', $broadcast->id)->where('status', PlatformSmsBroadcastRecipient::PENDING)->count();
        if ($pending === 0) {
            self::finish($broadcast->id, PlatformSmsBroadcast::SENT, null);
        } elseif (SendingHours::open()) {
            self::dispatch($broadcast->id, 0);
        }
    }

    private function overCap(string $tenantId, string $broadcastId): bool
    {
        return PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('tenant_id', $tenantId)
            ->where('broadcast_id', '<>', $broadcastId)->where('status', PlatformSmsBroadcastRecipient::SENT)
            ->where('created_at', '>=', now()->subDays(7))->count() >= (int) config('sms.platform.weekly_cap', 2);
    }

    /** P89B-10 / P89B-22: retry the batch with the backoff until 30 min after it started; then fail the rest. */
    private function retryOrFail(PlatformSmsBroadcast $broadcast, SmsSendFailed $e): void
    {
        $started = Carbon::parse($broadcast->started_at ?? $broadcast->updated_at);
        $deadline = $started->copy()->addMinutes((int) config('sms.platform.retry_window_minutes', 30));
        $backoff = (array) config('sms.platform.retry_backoff_seconds', [30, 60, 120, 240, 480, 900]);
        if (now()->lt($deadline) && $this->attempt < count($backoff)) {
            self::dispatch($broadcast->id, $this->attempt + 1)->delay(now()->addSeconds(max(1, min((int) $backoff[$this->attempt], (int) now()->diffInSeconds($deadline, true)))));

            return;
        }
        PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('broadcast_id', $broadcast->id)
            ->where('status', PlatformSmsBroadcastRecipient::PENDING)->update(['status' => PlatformSmsBroadcastRecipient::FAILED, 'updated_at' => now()]);
        self::refreshCounts($broadcast->id);
        $sent = (int) BroadcastService::query()->whereKey($broadcast->id)->value('sent_count');
        self::finish($broadcast->id, $sent > 0 ? PlatformSmsBroadcast::SENT : PlatformSmsBroadcast::FAILED,
            $sent > 0 ? null : ($e->errorCode() === SmsSendFailed::NO_ROUTE ? 'promotional_sender_not_approved' : SmsSendFailed::PROVIDER_UNAVAILABLE));
    }

    public static function refreshCounts(string $broadcastId): void
    {
        $counts = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('broadcast_id', $broadcastId)
            ->selectRaw('status, count(*) as c')->groupBy('status')->pluck('c', 'status');
        BroadcastService::query()->whereKey($broadcastId)->update([
            'recipients_count' => (int) $counts->sum(),
            'sent_count' => (int) ($counts[PlatformSmsBroadcastRecipient::SENT] ?? 0),
            'failed_count' => (int) ($counts[PlatformSmsBroadcastRecipient::FAILED] ?? 0),
            'skipped_count' => (int) ($counts[PlatformSmsBroadcastRecipient::SKIPPED] ?? 0),
            'updated_at' => now(),
        ]);
    }

    private static function finish(string $broadcastId, string $status, ?string $reason): void
    {
        $moved = BroadcastService::query()->whereKey($broadcastId)->where('status', PlatformSmsBroadcast::SENDING)
            ->update(['status' => $status, 'finished_at' => now(), 'failure_reason' => $reason, 'updated_at' => now()]);
        if ($moved === 1) {
            $b = BroadcastService::query()->whereKey($broadcastId)->first();
            app(AuditLogger::class)->log('platform_sms_broadcast.finished', $b, ['status' => $status, 'sent' => $b?->sent_count,
                'failed' => $b?->failed_count, 'skipped' => $b?->skipped_count], tenantId: false, system: true);
        }
    }
}
