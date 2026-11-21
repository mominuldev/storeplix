<?php

namespace App\Domain\Sms\Jobs;

use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Str;

/**
 * Sends one SMS. Dispatched after the response, so the HTTP request never waits on the
 * provider. The text (which may contain an OTP) lives only in the job payload, never in the DB.
 */
class SendSms implements ShouldQueue
{
    use Queueable;

    public int $tries = 1; // the gateway itself retries connection errors; never resend an accepted SMS

    public function __construct(
        public readonly string $smsMessageId,
        #[\SensitiveParameter] public readonly string $text,
    ) {}

    public function handle(SmsGateway $gateway): void
    {
        $message = SmsMessage::query()->find($this->smsMessageId);
        if ($message === null || $message->status !== 'queued') {
            return;
        }

        try {
            $result = $gateway->send($message->to, $this->text);
            $message->update(['status' => 'sent', 'provider_message_id' => $result->message_id]);
        } catch (SmsSendFailed $e) {
            $message->update(['status' => 'failed', 'error' => Str::limit($e->getMessage(), 250)]);
        }
    }
}
