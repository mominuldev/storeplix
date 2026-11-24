<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use Carbon\CarbonImmutable;

/**
 * "Repeat every month" date maths (PHASE-8-7 P87-9). All dates are store-local `Y-m-d` strings. A `day_of_month` the
 * month doesn't have (29–31) becomes that month's last day: 31 → 30 Apr, 28/29 Feb, back to 31 in months that have it.
 */
final class MonthlySchedule
{
    /** The series date in the given month (clamped to its last day). */
    public static function inMonth(int $year, int $month, int $day): string
    {
        $first = CarbonImmutable::create($year, $month, 1, 0, 0, 0, 'UTC');

        return $first->setDay(min($day, $first->daysInMonth))->format('Y-m-d');
    }

    /** The first series date strictly after $today (no catch-up for back-dated starts). */
    public static function firstAfter(string $today, int $day): string
    {
        $t = CarbonImmutable::createFromFormat('!Y-m-d', $today, 'UTC');
        $candidate = self::inMonth($t->year, $t->month, $day);
        if ($candidate > $today) {
            return $candidate;
        }
        $next = $t->startOfMonth()->addMonthNoOverflow();

        return self::inMonth($next->year, $next->month, $day);
    }

    /** The series date one month after $current's month. */
    public static function advance(string $current, int $day): string
    {
        $next = CarbonImmutable::createFromFormat('!Y-m-d', $current, 'UTC')->startOfMonth()->addMonthNoOverflow();

        return self::inMonth($next->year, $next->month, $day);
    }

    /** Day of month of a `Y-m-d` date. */
    public static function dayOf(string $date): int
    {
        return (int) substr($date, 8, 2);
    }
}
