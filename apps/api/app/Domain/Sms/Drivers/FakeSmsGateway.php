<?php

namespace App\Domain\Sms\Drivers;

use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;

/** Tests: records messages in memory. */
class FakeSmsGateway implements SmsGateway
{
    /** @var list<array{to: string, text: string, sender_id: string|null}> */
    public array $sent = [];

    public bool $failNext = false;

    public function send(string $msisdn, string $text, ?string $senderId = null): SmsResult
    {
        if ($this->failNext) {
            $this->failNext = false;

            throw new SmsSendFailed('Fake failure.');
        }

        $this->sent[] = ['to' => $msisdn, 'text' => $text, 'sender_id' => $senderId];

        return new SmsResult('fake-'.count($this->sent), true, ['driver' => 'fake']);
    }

    public function status(string $messageId): array
    {
        return ['Status' => '0'];
    }

    /** Last OTP code sent to a number (parsed from the text). */
    public function lastCodeFor(string $msisdn): ?string
    {
        foreach (array_reverse($this->sent) as $message) {
            if ($message['to'] === $msisdn && preg_match('/\b(\d{6})\b/', $message['text'], $m)) {
                return $m[1];
            }
        }

        return null;
    }
}
