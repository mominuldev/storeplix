<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Shared\Http\ApiException;
use Illuminate\Support\Carbon;
use Illuminate\Validation\ValidationException;

/** PHASE-8-9B P89B-18 (S228): promotional SMS only leave in [09:00, 21:00) Asia/Dhaka. */
final class SendingHours
{
    public static function timezone(): string
    {
        return (string) config('sms.platform.timezone', 'Asia/Dhaka');
    }

    public static function contains(Carbon $at): bool
    {
        $local = $at->copy()->timezone(self::timezone());
        $minutes = $local->hour * 60 + $local->minute;

        return $minutes >= (int) config('sms.platform.sending_hours.from', 9) * 60 && $minutes < (int) config('sms.platform.sending_hours.to', 21) * 60;
    }

    public static function open(): bool
    {
        return self::contains(now());
    }

    /** scheduled_at: inside the window, ≥ now + 5 min, ≤ now + 30 days; null = send now (must be inside the window). */
    public static function assertSchedulable(?Carbon $at, string $field = 'scheduled_at'): void
    {
        if ($at === null) {
            if (! self::open()) {
                throw new ApiException(422, 'outside_sending_hours', 'Promotional SMS go out only between 9 AM and 9 PM (Dhaka). Schedule it instead.');
            }

            return;
        }
        if ($at->lt(now()->addMinutes(5)) || $at->gt(now()->addDays(30))) {
            throw ValidationException::withMessages([$field => ['Pick a time at least 5 minutes from now and within 30 days.']]);
        }
        if (! self::contains($at)) {
            throw new ApiException(422, 'outside_sending_hours', 'Promotional SMS go out only between 9 AM and 9 PM (Dhaka).');
        }
    }
}
