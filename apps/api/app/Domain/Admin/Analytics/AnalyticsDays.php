<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use Carbon\CarbonImmutable;

/**
 * Dhaka days (PHASE-8-2 P82-2). A day `D` is `[D 00:00, D+1 00:00)` in `ANALYTICS_TIMEZONE`, converted with the
 * timezone (never a hard-coded offset). Days are `Y-m-d` strings; instants are UTC CarbonImmutable (bound as
 * `Y-m-d H:i:s` UTC, like every other timestamp in the app).
 */
final class AnalyticsDays
{
    public static function tz(): string
    {
        return (string) config('analytics.timezone', 'Asia/Dhaka');
    }

    /** Today's Dhaka date. */
    public static function today(): string
    {
        return CarbonImmutable::now(self::tz())->toDateString();
    }

    /** Midnight at the start of the day, in UTC. */
    public static function startUtc(string $day): CarbonImmutable
    {
        return CarbonImmutable::createFromFormat('!Y-m-d', $day, self::tz())->utc();
    }

    /** Midnight at the end of the day (= start of the next day), in UTC. */
    public static function endUtc(string $day): CarbonImmutable
    {
        return self::startUtc(self::add($day, 1));
    }

    public static function add(string $day, int $days): string
    {
        return CarbonImmutable::createFromFormat('!Y-m-d', $day, 'UTC')->addDays($days)->toDateString();
    }

    /** Whole days from $a to $b ($b − $a). */
    public static function diff(string $a, string $b): int
    {
        return (int) CarbonImmutable::createFromFormat('!Y-m-d', $a, 'UTC')->diffInDays(CarbonImmutable::createFromFormat('!Y-m-d', $b, 'UTC'), false);
    }

    /** The Dhaka day of a stored timestamp (UTC string or DateTime). */
    public static function dayOf(mixed $timestamp): ?string
    {
        if ($timestamp === null || $timestamp === '') {
            return null;
        }
        $at = $timestamp instanceof \DateTimeInterface ? CarbonImmutable::instance($timestamp) : CarbonImmutable::parse((string) $timestamp, 'UTC');

        return $at->setTimezone(self::tz())->toDateString();
    }

    /** `YYYY-MM` of a day. */
    public static function month(string $day): string
    {
        return substr($day, 0, 7);
    }

    public static function firstOfMonth(string $day): string
    {
        return substr($day, 0, 7).'-01';
    }

    public static function lastOfMonth(string $day): string
    {
        return CarbonImmutable::createFromFormat('!Y-m-d', self::firstOfMonth($day), 'UTC')->endOfMonth()->toDateString();
    }

    public static function addMonths(string $day, int $months): string
    {
        return CarbonImmutable::createFromFormat('!Y-m-d', $day, 'UTC')->addMonthsNoOverflow($months)->toDateString();
    }

    /** ISO day of week, 1 = Monday … 7 = Sunday. */
    public static function isoWeekday(string $day): int
    {
        return (int) CarbonImmutable::createFromFormat('!Y-m-d', $day, 'UTC')->isoWeekday();
    }

    /** Rates and shares: fraction in [0, 1] rounded half-up to 4 decimals; null when the denominator is 0. */
    public static function rate(int|float|null $numerator, int|float|null $denominator): ?float
    {
        if ($numerator === null || $denominator === null || $denominator == 0) {
            return null;
        }

        return round($numerator / $denominator, 4);
    }
}
