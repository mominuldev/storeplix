<?php

declare(strict_types=1);

namespace App\Domain\Sms;

/**
 * PHASE-8-9B §4.3 (`SmsMessageGroup`): the unit of routing. `shop` = every 8.9a merchant-to-customer SMS; the four
 * platform groups carry Store Plix's own SMS. The primary must carry shop, registration, billing and security (P89B-6).
 */
enum SmsRoute: string
{
    case Shop = 'shop';
    case Registration = 'registration';
    case Billing = 'billing';
    case Security = 'security';
    case Promotional = 'promotional';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $r) => $r->value, self::cases());
    }

    /** @return list<string> P89B-6 */
    public static function primaryRequired(): array
    {
        return [self::Shop->value, self::Registration->value, self::Billing->value, self::Security->value];
    }
}
