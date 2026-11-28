<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Jobs;

use App\Domain\FraudGuard\CheckoutOtpService;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Sends one checkout code (P88-13), after the response. The text (with the code) lives only in the job payload. A
 * provider failure marks the message failed and the number "OTP unavailable" so the shopper's checkout fails open.
 */
class SendCheckoutOtp implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public function __construct(
        public readonly string $smsMessageId,
        public readonly string $storeId,
        #[\SensitiveParameter] public readonly string $text,
    ) {}

    public function handle(SmsGateway $gateway, CheckoutOtpService $otp, SmsCharger $charger): void
    {
        $message = SmsMessage::query()->find($this->smsMessageId);
        if ($message === null || $message->status !== SmsMessage::QUEUED) {
            return;
        }
        try {
            $result = $gateway->send($message->to, $this->text, $message->sender_id); // PHASE-8-9A: the masked sender charged with
            $message->markSent($result->message_id, $result);
        } catch (SmsSendFailed $e) {
            $message->markFailed(Str::limit($e->getMessage(), 250), $e);
            $charger->refund($message); // PHASE-8-9A §4.2: credits back on a final provider failure
            $otp->markFailed($this->storeId, $message->to);
            Log::warning('fraud_guard.otp_sms_failed', ['store_id' => $this->storeId]);
        }
    }
}
