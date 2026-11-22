<?php

namespace App\Domain\Shared\Support;

use InvalidArgumentException;

/** Display helpers for integer paisa amounts (1 ৳ = 100 paisa), and the exact decimal bridge for gateways. */
final class Money
{
    /**
     * Paisa → decimal taka string for gateways: 177000 → "1770.00", 5 → "0.05" (PHASE-5B Conventions). Integer
     * arithmetic only, never float.
     */
    public static function toDecimal(int $paisa): string
    {
        $sign = $paisa < 0 ? '-' : '';
        $abs = $paisa < 0 ? -$paisa : $paisa;

        return $sign.intdiv($abs, 100).'.'.str_pad((string) ($abs % 100), 2, '0', STR_PAD_LEFT);
    }

    /**
     * Provider decimal taka string → paisa: "1770" → 177000, "1770.5" → 177050, "1770.05" → 177005. String parsing
     * only (never float). More than 2 decimals, signs other than a leading "-", exponents, separators or blanks
     * throw: the caller treats the amount as a mismatch (P5B-16).
     *
     * @throws InvalidArgumentException
     */
    public static function fromDecimal(string $amount): int
    {
        $amount = trim($amount);
        if (preg_match('/^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/', $amount, $m) !== 1) {
            throw new InvalidArgumentException('Not a decimal amount with at most 2 decimals.');
        }
        $paisa = (int) $m[2] * 100 + (int) str_pad($m[3] ?? '', 2, '0');

        return $m[1] === '-' ? -$paisa : $paisa;
    }

    /** fromDecimal() that returns null instead of throwing (amount missing, float or invalid = mismatch). */
    public static function tryFromDecimal(mixed $amount): ?int
    {
        if (is_int($amount)) {
            $amount = (string) $amount; // a whole-taka JSON integer is exact; JSON floats are never trusted
        }
        if (! is_string($amount)) {
            return null;
        }
        try {
            return self::fromDecimal($amount);
        } catch (InvalidArgumentException) {
            return null;
        }
    }

    /** "৳ 3,900" / "৳ 3,900.50" */
    public static function bdt(int $paisa): string
    {
        return '৳ '.self::plain($paisa);
    }

    /** "3,900" / "3,900.50" (SMS uses "Tk" / "টাকা" since ৳ isn't GSM-7). */
    public static function plain(int $paisa): string
    {
        $decimals = $paisa % 100 === 0 ? 0 : 2;

        return number_format($paisa / 100, $decimals, '.', ',');
    }
}
