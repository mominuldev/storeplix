<?php

namespace App\Domain\Shared\Support;

/**
 * Phone normalisation.
 *  - BD mobile: 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX (operators 013–019).
 *  - Account phones (users.phone, OTP) are stored/sent as "8801XXXXXXXXX" (Addendum A).
 *  - Store contact phones are stored as E.164 "+8801XXXXXXXXX" or any E.164 number (§1.4).
 */
final class Phone
{
    public const BD_MOBILE = '/^(?:\+?88)?(01[3-9]\d{8})$/';

    public const E164 = '/^\+[1-9]\d{7,14}$/';

    public static function clean(string $value): string
    {
        return preg_replace('/[\s\-().]/', '', trim($value)) ?? '';
    }

    /** "8801XXXXXXXXX" or null when not a BD mobile number. */
    public static function bdMsisdn(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        return preg_match(self::BD_MOBILE, self::clean($value), $m) ? '88'.$m[1] : null;
    }

    /** E.164 for a BD mobile or any valid E.164 number; null otherwise. */
    public static function e164(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }

        $bd = self::bdMsisdn($value);
        if ($bd !== null) {
            return '+'.$bd;
        }

        $clean = self::clean($value);

        return preg_match(self::E164, $clean) ? $clean : null;
    }

    /** 8801*******89 style mask for API output / logs. */
    public static function mask(string $msisdn): string
    {
        $len = strlen($msisdn);

        return $len <= 6 ? str_repeat('*', $len) : substr($msisdn, 0, 4).str_repeat('*', $len - 6).substr($msisdn, -2);
    }
}
