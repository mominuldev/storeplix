<?php

namespace App\Domain\Sms\Jobs;

use App\Domain\Sms\Platform\PlatformSmsDelivery;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsRoute;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Sends one account code (Addendum A). Dispatched after the response, so the HTTP request never waits on the
 * provider. The text (which contains the OTP) lives only in the job payload, never in the DB.
 *
 * PHASE-8-9B §4.5: routed by group (`registration` for phone verification, `security` for sign-in / reset codes); a
 * provider-level failure on every candidate is retried with the backoff until 5 minutes after the row was created (the
 * code's TTL), then `failed` / `provider_unavailable`. A timeout or a rejection is never retried.
 */
class SendSms implements ShouldQueue
{
    use Queueable;

    public int $tries = 1; // retries are new jobs within the window; an accepted SMS is never resent

    public function __construct(
        public readonly string $smsMessageId,
        #[\SensitiveParameter] public readonly string $text,
        public readonly string $route = 'security',
        public readonly int $attempt = 0,
    ) {}

    public function handle(SmsGateway $gateway): void
    {
        [$outcome, $delay] = PlatformSmsDelivery::attempt($gateway, $this->smsMessageId, $this->text, SmsRoute::from($this->route),
            (int) config('sms.platform.code_retry_window_minutes', 5), $this->attempt);
        if ($outcome === 'retry') {
            self::dispatch($this->smsMessageId, $this->text, $this->route, $this->attempt + 1)->delay(now()->addSeconds($delay));
        }
    }
}
