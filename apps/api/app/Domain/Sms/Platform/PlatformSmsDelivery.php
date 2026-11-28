<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * PHASE-8-9B §4.5 (P89B-10): one delivery attempt of a platform SMS row (`tenant_id` NULL) and its retry decision.
 * Provider-level failures (`unavailable` / `auth` on every candidate, or `no_route`) keep the row `queued` and ask for
 * another attempt with the backoff (30 s, 1, 2, 4, 8, 15 min) while inside the window (30 min; codes 5 min) from the
 * row's `created_at`; then `failed` / `provider_unavailable`. A timeout (maybe accepted) and a rejection are final.
 * Rows are written on the platform connection: the job runs without a tenant (not TenantAware).
 */
final class PlatformSmsDelivery
{
    /** @return 'sent'|'failed'|'retry' plus the delay in seconds for a retry */
    public static function attempt(SmsGateway $gateway, string $messageId, string $text, SmsRoute $route, int $windowMinutes, int $attempt): array
    {
        $message = self::query()->whereKey($messageId)->first();
        if ($message === null || $message->status !== SmsMessage::QUEUED) {
            return ['done', 0];
        }
        try {
            $result = $gateway->send($message->to, $text, null, $route);
        } catch (SmsSendFailed $e) {
            $deadline = Carbon::parse($message->created_at)->addMinutes($windowMinutes);
            $backoff = (array) config('sms.platform.retry_backoff_seconds', [30, 60, 120, 240, 480, 900]);
            if ($e->providerLevel() && now()->lt($deadline) && $attempt < count($backoff)) {
                self::query()->whereKey($messageId)->update(['error_code' => $e->errorCode(), 'provider_id' => $e->providerId,
                    'error' => self::detail($e), 'updated_at' => now()]);

                return ['retry', max(1, min((int) $backoff[$attempt], (int) now()->diffInSeconds($deadline, true)))];
            }
            self::query()->whereKey($messageId)->update([
                'status' => SmsMessage::FAILED,
                'error_code' => $e->providerLevel() ? SmsSendFailed::PROVIDER_UNAVAILABLE : $e->errorCode(),
                'provider_id' => $e->providerId, 'error' => self::detail($e), 'updated_at' => now(),
            ]);

            return ['failed', 0];
        }
        self::markSent($messageId, $result);

        return ['sent', 0];
    }

    public static function markSent(string $messageId, SmsResult $result): void
    {
        self::query()->whereKey($messageId)->update([
            'status' => SmsMessage::SENT, 'provider_message_id' => $result->message_id, 'provider_id' => $result->provider_id,
            'sent_at' => now(), 'error_code' => $result->failover_error_code,
            'error' => $result->failover_detail !== null ? mb_substr($result->failover_detail, 0, 250) : null, 'updated_at' => now(),
        ]);
    }

    public static function markFailed(string $messageId, SmsSendFailed $e): void
    {
        self::query()->whereKey($messageId)->update(['status' => SmsMessage::FAILED, 'error_code' => $e->errorCode(),
            'provider_id' => $e->providerId, 'error' => self::detail($e), 'updated_at' => now()]);
    }

    /** Inserts a platform row on the platform connection (`id` may be preset). @param array<string, mixed> $attributes */
    public static function create(array $attributes): SmsMessage
    {
        $message = new SmsMessage;
        $message->forceFill($attributes);
        $message->setConnection(PlatformDb::connectionName());
        $message->save();

        return $message;
    }

    /** @return Builder<SmsMessage> */
    public static function query(): Builder
    {
        return PlatformDb::reroute(SmsMessage::query());
    }

    private static function detail(SmsSendFailed $e): string
    {
        return Str::limit((string) ($e->detail ?? $e->getMessage()), 250);
    }
}
