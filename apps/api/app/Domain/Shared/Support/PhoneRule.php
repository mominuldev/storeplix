<?php

namespace App\Domain\Shared\Support;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * "bd"     → BD mobile only (account phones, OTP).
 * "contact"→ BD mobile or E.164 (store contact phone / WhatsApp, §1.4).
 */
final class PhoneRule implements ValidationRule
{
    private function __construct(private readonly bool $allowE164) {}

    public static function bdMobile(): self
    {
        return new self(false);
    }

    public static function contact(): self
    {
        return new self(true);
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $ok = is_string($value) && ($this->allowE164 ? Phone::e164($value) !== null : Phone::bdMsisdn($value) !== null);

        if (! $ok) {
            $fail($this->allowE164
                ? 'Enter a Bangladesh mobile number (01XXXXXXXXX) or an international number (+…).'
                : 'Enter a Bangladesh mobile number, e.g. 01712345678.');
        }
    }
}
