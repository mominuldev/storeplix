<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use Carbon\CarbonInterface;
use Illuminate\Support\Carbon;

/**
 * Quiet hours (P85-15, Q142): no campaign starts between 21:00 and 09:00 store time, and a campaign still sending at
 * 21:00 pauses until 09:00. Times are evaluated in the store timezone.
 */
final class QuietHours
{
    public static function isQuiet(CarbonInterface $at, string $timezone): bool
    {
        $hour = (int) Carbon::instance($at)->setTimezone($timezone ?: 'Asia/Dhaka')->format('G');
        $from = (int) config('campaigns.quiet_from', 21);
        $to = (int) config('campaigns.quiet_to', 9);

        return $from > $to ? ($hour >= $from || $hour < $to) : ($hour >= $from && $hour < $to);
    }

    /** The next 09:00 store time at or after $at (as UTC). */
    public static function allowedFrom(CarbonInterface $at, string $timezone): Carbon
    {
        $local = Carbon::instance($at)->setTimezone($timezone ?: 'Asia/Dhaka');
        $to = (int) config('campaigns.quiet_to', 9);
        $next = $local->copy()->setTime($to, 0);
        if ($next->lt($local)) {
            $next->addDay();
        }

        return $next->utc();
    }
}
