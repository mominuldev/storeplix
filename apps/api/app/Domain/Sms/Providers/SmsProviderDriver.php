<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;

/** PHASE-8-9B §4.1: one SMS provider API. Only the router (and the provider test / rotation) calls a driver. */
interface SmsProviderDriver
{
    /** @throws SmsSendFailed with ->reason: rejected | unavailable | timeout | auth */
    public function send(SmsConnection $c, string $msisdn, string $text, string $senderId): SmsResult;

    /**
     * null = not supported by this driver.
     *
     * @throws SmsSendFailed when the balance can't be read
     */
    public function balance(SmsConnection $c): ?SmsBalance;
}
