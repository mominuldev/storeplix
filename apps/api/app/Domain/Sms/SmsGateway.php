<?php

namespace App\Domain\Sms;

/**
 * The one door every SMS goes through (PHASE-8-9B §4.3: the binding is the router, RoutingSmsGateway; SMS_DRIVER=log|fake
 * bind that driver directly, P89B-2). An arch test keeps every other class off the drivers.
 */
interface SmsGateway
{
    /**
     * @param  string  $msisdn  8801XXXXXXXXX
     * @param  string|null  $senderId  PHASE-8-9A §4.1: the shop's approved masked sender ID; null = the carrying provider's default
     * @param  SmsRoute  $route  PHASE-8-9B §4.3: the message group (picks the provider; promotional uses the promotional mask)
     *
     * @throws SmsSendFailed
     */
    public function send(string $msisdn, string $text, ?string $senderId = null, SmsRoute $route = SmsRoute::Shop): SmsResult;

    /** Provider delivery status for a message id (raw provider payload). */
    public function status(string $messageId): array;
}
