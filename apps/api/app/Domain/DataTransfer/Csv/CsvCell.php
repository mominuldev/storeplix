<?php

namespace App\Domain\DataTransfer\Csv;

/**
 * Formula-injection safety (§5.6). Every exported cell (exports, error report, template) goes through safe();
 * import strips the guard quote again (unescape) so files round-trip.
 */
final class CsvCell
{
    /** ASCII = + - @ TAB CR and the full-width ＝ ＋ － ＠. */
    private const TRIGGERS = ['=', '+', '-', '@', "\t", "\r", '＝', '＋', '－', '＠'];

    public static function safe(string $value): string
    {
        return self::triggered($value) ? "'".$value : $value;
    }

    /** One leading "'" is removed when the next character is a trigger (the reverse of safe()). */
    public static function unescape(string $value): string
    {
        return str_starts_with($value, "'") && self::triggered(substr($value, 1)) ? substr($value, 1) : $value;
    }

    /** First character after leading spaces/newlines is a trigger (TAB and CR are triggers themselves). */
    private static function triggered(string $value): bool
    {
        $first = mb_substr(ltrim($value, " \n\x0B\f"), 0, 1);

        return $first !== '' && in_array($first, self::TRIGGERS, true);
    }

    /** Numbers we generate are never negative, so they are written as-is. */
    public static function number(int|float|null $value): string
    {
        return $value === null ? '' : (string) $value;
    }
}
