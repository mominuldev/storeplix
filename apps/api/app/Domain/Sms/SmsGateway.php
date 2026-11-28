<?php

namespace App\Domain\Sms;

interface SmsGateway
{
    /**
     * @param  string  $msisdn  8801XXXXXXXXX
     * @param  string|null  $senderId  PHASE-8-9A §4.1: the shop's approved masked sender ID; null = the platform caller ID
     *
     * @throws SmsSendFailed
     */
    public function send(string $msisdn, string $text, ?string $senderId = null): SmsResult;

    /** Provider delivery status for a message id (raw provider payload). */
    public function status(string $messageId): array;
}
