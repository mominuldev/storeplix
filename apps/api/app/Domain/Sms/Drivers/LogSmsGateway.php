<?php

namespace App\Domain\Sms\Drivers;

use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/** Local development: writes the SMS to the log, sends nothing. */
class LogSmsGateway implements SmsGateway
{
    public function send(string $msisdn, string $text, ?string $senderId = null): SmsResult
    {
        Log::info('sms.log_driver', ['to' => $msisdn, 'text' => $text, 'sender_id' => $senderId]);

        return new SmsResult('log-'.Str::lower((string) Str::ulid()), true, ['driver' => 'log']);
    }

    public function status(string $messageId): array
    {
        return ['Status' => '0', 'driver' => 'log'];
    }
}
