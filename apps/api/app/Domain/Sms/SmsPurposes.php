<?php

declare(strict_types=1);

namespace App\Domain\Sms;

/**
 * PHASE-8-9A §3.4 (P89A-4): merchant-visible SMS purposes and their kind. Account codes (`otp_*`) live in the same
 * table but are platform-paid: never charged, counted or listed.
 */
final class SmsPurposes
{
    public const TRANSACTIONAL = 'transactional';

    public const MARKETING = 'marketing';

    public const KINDS = [self::TRANSACTIONAL, self::MARKETING];

    public const SMS_TEST = 'sms_test';

    public const CAMPAIGN = 'campaign';

    public const AUTOMATION = 'automation';

    public const CHECKOUT_OTP = 'checkout_otp';

    /** PHASE-8-8E P88E-11: the website-chat verification code (transactional; body never stored). */
    public const INBOX_VERIFY = 'inbox_verify';

    /** PHASE-8-8E P88E-12: "the shop replied" with a magic link (transactional; reference `conversation`). */
    public const INBOX_REPLY = 'inbox_reply';

    /** SmsPurpose (openapi) in display order. */
    public const LISTED = [
        'order_placed', 'order_confirmed', 'order_shipped', 'order_cancelled', 'order_updated', 'payment_link', 'pos_receipt',
        self::CHECKOUT_OTP, self::INBOX_VERIFY, self::INBOX_REPLY, self::CAMPAIGN, self::AUTOMATION, self::SMS_TEST,
    ];

    public const MARKETING_PURPOSES = [self::CAMPAIGN, self::AUTOMATION];

    public static function kindOf(string $purpose): string
    {
        return in_array($purpose, self::MARKETING_PURPOSES, true) ? self::MARKETING : self::TRANSACTIONAL;
    }

    public static function isAccountCode(string $purpose): bool
    {
        return str_starts_with($purpose, 'otp_') || (! in_array($purpose, self::LISTED, true) && ! self::isPlatformMessage($purpose));
    }

    /** PHASE-8-9B §3.2: Store Plix's own non-code SMS (`platform_*`): previewed like shop SMS, never charged or listed to a shop. */
    public static function isPlatformMessage(string $purpose): bool
    {
        return str_starts_with($purpose, 'platform_');
    }
}
