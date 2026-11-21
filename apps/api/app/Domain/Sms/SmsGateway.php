<?php

namespace App\Domain\Sms;

interface SmsGateway
{
    /**
     * @param  string  $msisdn  8801XXXXXXXXX
     *
     * @throws SmsSendFailed
     */
    public function send(string $msisdn, string $text): SmsResult;

    /** Provider delivery status for a message id (raw provider payload). */
    public function status(string $messageId): array;
}
