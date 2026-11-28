<?php

declare(strict_types=1);

namespace App\Domain\Tracking;

use App\Domain\Shared\Support\Phone;

/**
 * PHASE-8-9D P89D-13 (S337): customer data is normalised and SHA-256 hashed before it is stored in a delivery payload.
 * email: trimmed + lower-cased; phone: E.164 `+8801XXXXXXXXX` (invalid → omitted) — Meta's `ph` hashes the digits
 * without `+`; first / last name and city: lower-cased, spaces removed; country `bd`; external_id = SHA-256(customer id).
 * Raw values never leave this class. Formats per provider are VERIFY items (§1 P89D-13).
 */
final class UserDataHasher
{
    public static function sha(string $value): string
    {
        return hash('sha256', $value);
    }

    public static function email(?string $email): ?string
    {
        $value = mb_strtolower(trim((string) $email));

        return $value === '' || ! str_contains($value, '@') ? null : self::sha($value);
    }

    /** SHA-256 of the E.164 string (`+8801…`): GA4, TikTok, GTM. */
    public static function phone(?string $phone): ?string
    {
        $e164 = Phone::e164($phone);

        return $e164 === null ? null : self::sha($e164);
    }

    /** Meta `ph`: SHA-256 of the E.164 digits without `+`. */
    public static function metaPhone(?string $phone): ?string
    {
        $e164 = Phone::e164($phone);

        return $e164 === null ? null : self::sha(ltrim($e164, '+'));
    }

    public static function name(?string $value): ?string
    {
        $clean = preg_replace('/\s+/u', '', mb_strtolower(trim((string) $value))) ?? '';

        return $clean === '' ? null : self::sha($clean);
    }

    /**
     * The hashed user block for one order (null fields dropped).
     *
     * @return array<string, string>
     */
    public static function forOrder(?string $email, ?string $phone, ?string $fullName, ?string $city, ?string $customerId): array
    {
        $parts = preg_split('/\s+/u', trim((string) $fullName)) ?: [];
        $first = $parts[0] ?? null;
        $last = count($parts) > 1 ? $parts[count($parts) - 1] : null;

        return array_filter([
            'em' => self::email($email),
            'ph' => self::phone($phone),
            'ph_meta' => self::metaPhone($phone),
            'fn' => self::name($first),
            'ln' => self::name($last),
            'ct' => self::name($city),
            'country' => self::sha('bd'),
            'external_id' => $customerId !== null && $customerId !== '' ? self::sha($customerId) : null,
        ], fn ($v) => $v !== null);
    }
}
