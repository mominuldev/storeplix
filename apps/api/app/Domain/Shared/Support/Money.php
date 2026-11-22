<?php

namespace App\Domain\Shared\Support;

/** Display helpers for integer paisa amounts (1 ৳ = 100 paisa). */
final class Money
{
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
