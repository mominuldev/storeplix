<?php

declare(strict_types=1);

namespace App\Domain\Sms\Jobs;

use App\Domain\Sms\Platform\PlatformSmsDelivery;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\SmsGateway;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * PHASE-8-9B §5: one platform SMS (welcome, invoice and billing notices) for a queued `sms_messages` row with
 * `tenant_id` NULL. Not TenantAware (runs without a tenant). Retry window 30 minutes (P89B-10). The payload carries the
 * rendered text and ids only — never a credential.
 */
class SendPlatformSms implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(
        public readonly string $smsMessageId,
        public readonly string $text,
        public readonly string $type,
        public readonly int $attempt = 0,
    ) {
        $this->onQueue('notifications');
    }

    public function handle(SmsGateway $gateway): void
    {
        $type = PlatformSmsType::from($this->type);
        [$outcome, $delay] = PlatformSmsDelivery::attempt($gateway, $this->smsMessageId, $this->text, $type->route(), $type->retryWindowMinutes(), $this->attempt);
        if ($outcome === 'retry') {
            self::dispatch($this->smsMessageId, $this->text, $this->type, $this->attempt + 1)->delay(now()->addSeconds($delay));
        }
    }
}
