<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Customers\Models\Customer;
use App\Domain\Marketing\Models\Campaign;
use App\Domain\Shared\Support\Phone;

/**
 * "Address" (PHASE-8-5 conventions): normalized phone `8801XXXXXXXXX` for SMS (the customers normalizer), trimmed
 * lower-case email for email. Masking for every merchant/shopper response (P85-23): `+880 17•• •••123`,
 * `n•••@gmail.com`.
 */
final class MarketingAddress
{
    public static function normalize(string $channel, ?string $value): ?string
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        if ($channel === Campaign::SMS) {
            return Phone::bdMsisdn($value);
        }
        $email = mb_strtolower(trim($value));

        return filter_var($email, FILTER_VALIDATE_EMAIL) !== false ? $email : null;
    }

    public static function ofCustomer(Customer $customer, string $channel): ?string
    {
        return self::normalize($channel, $channel === Campaign::SMS ? $customer->phone : $customer->email);
    }

    public static function mask(string $channel, string $address): string
    {
        if ($channel === Campaign::SMS) {
            $national = str_starts_with($address, '880') ? substr($address, 3) : ltrim($address, '+');
            if (strlen($national) < 6) {
                return '+880 ••••';
            }

            return '+880 '.substr($national, 0, 2).'•• •••'.substr($national, -3);
        }
        $at = strrpos($address, '@');
        if ($at === false || $at === 0) {
            return '•••';
        }

        return mb_substr($address, 0, 1).'•••'.substr($address, $at);
    }
}
