<?php

namespace App\Domain\Sms\Drivers;

use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;

/** Tests (SMS_DRIVER=fake): records messages in memory; never routes to a database provider (PHASE-8-9B S231). */
class FakeSmsGateway implements SmsGateway
{
    /** @var list<array{to: string, text: string, sender_id: string|null}> */
    public array $sent = [];

    public bool $failNext = false;

    /** PHASE-8-9B: the route of each entry of $sent (same index). @var list<string> */
    public array $routes = [];

    /** PHASE-8-9B: when set, the next send fails with this reason (unavailable | timeout | auth | rejected). */
    public ?string $failNextReason = null;

    public function send(string $msisdn, string $text, ?string $senderId = null, SmsRoute $route = SmsRoute::Shop): SmsResult
    {
        if ($this->failNextReason !== null) {
            $reason = $this->failNextReason;
            $this->failNextReason = null;

            throw new SmsSendFailed('Fake failure.', $reason, null, 'Fake failure');
        }
        if ($this->failNext) {
            $this->failNext = false;

            throw new SmsSendFailed('Fake failure.');
        }

        $this->sent[] = ['to' => $msisdn, 'text' => $text, 'sender_id' => $senderId];
        $this->routes[] = $route->value;

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
