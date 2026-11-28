<?php

declare(strict_types=1);

namespace App\Domain\Sms\Drivers;

use App\Domain\Sms\Providers\SmsBalance;
use App\Domain\Sms\Providers\SmsConnection;
use App\Domain\Sms\Providers\SmsProviderDriver;
use App\Domain\Sms\SmsResult;
use Illuminate\Support\Str;

/**
 * PHASE-8-9B §4.2 `SMS_PROVIDERS_HTTP_FAKE=true` (dev / e2e only; refused at boot in production, S231): every provider
 * driver call answers a canned success without network — message id = a ULID, balance ৳5,000.
 */
final class CannedSmsDriver implements SmsProviderDriver
{
    public const BALANCE_PAISA = 500000;

    public function send(SmsConnection $c, string $msisdn, string $text, string $senderId): SmsResult
    {
        return new SmsResult(Str::lower((string) Str::ulid()), true, ['driver' => 'canned']);
    }

    public function balance(SmsConnection $c): ?SmsBalance
    {
        return new SmsBalance(self::BALANCE_PAISA);
    }
}
