<?php

declare(strict_types=1);

namespace App\Domain\Sms;

use App\Domain\Shared\Support\Phone;

/**
 * PHASE-8-9A P89A-21 (S217): what the SMS log may keep and show. Checkout codes, Inbox chat codes (PHASE-8-8E) and
 * account codes are never stored;
 * other previews are ≤ 160 characters with every link (scheme, `www.` or bare host with a path, e.g. the campaign
 * opt-out `shop.example/u/{code}` and payment-link tokens) replaced by `[link]`. Phones are masked `01711-•••211`.
 */
final class SmsPreview
{
    public const MAX = 160;

    public static function of(string $purpose, string $text): ?string
    {
        if ($purpose === SmsPurposes::CHECKOUT_OTP || $purpose === SmsPurposes::INBOX_VERIFY || SmsPurposes::isAccountCode($purpose)) {
            return null;
        }
        $text = (string) preg_replace('~(?:https?://|www\.)\S+~iu', '[link]', $text);
        $text = (string) preg_replace('~\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?/\S*~iu', '[link]', $text);
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));

        return $text === '' ? null : mb_substr($text, 0, self::MAX);
    }

    /** `8801711552211` → `01711-•••211` (first 5 local digits, `-•••`, last 3). */
    public static function maskPhone(?string $msisdn): string
    {
        $local = Phone::bdMsisdn($msisdn);
        $local = $local !== null ? '0'.substr($local, 3) : preg_replace('/\D/', '', (string) $msisdn);
        if (strlen((string) $local) < 8) {
            return '•••';
        }

        return substr((string) $local, 0, 5).'-•••'.substr((string) $local, -3);
    }
}
