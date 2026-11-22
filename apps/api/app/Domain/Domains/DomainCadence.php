<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Stores\Models\StoreDomain;
use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;

/**
 * PHASE-6-CONTRACT §2.2: when a domain is checked next. `check_attempts` counts the checks made in the current status
 * (reset by every transition).
 */
final class DomainCadence
{
    private const PENDING_MINUTES = [1, 5, 15];

    private const VERIFIED_MINUTES = [2, 5, 15, 30];

    /** Right after a transition into $status. */
    public static function afterTransition(string $status, CarbonInterface $now): ?CarbonImmutable
    {
        $now = CarbonImmutable::instance($now);

        return match ($status) {
            StoreDomain::STATUS_PENDING_VERIFICATION, StoreDomain::STATUS_VERIFIED => $now,
            StoreDomain::STATUS_SSL_PROVISIONING => $now->addMinutes(2),
            StoreDomain::STATUS_ACTIVE => self::daily($now),
            default => null,
        };
    }

    /** After a check that left the row in its status; $attempts includes this check. */
    public static function next(StoreDomain $row, int $attempts, CarbonInterface $now): ?CarbonImmutable
    {
        $now = CarbonImmutable::instance($now);

        return match ($row->status) {
            StoreDomain::STATUS_PENDING_VERIFICATION => self::capped(
                $now->addMinutes(self::PENDING_MINUTES[$attempts - 1] ?? 30),
                self::deadline($row->verification_started_at, (int) config('domains.verify_window_hours', 72)),
                $now,
            ),
            StoreDomain::STATUS_VERIFIED => self::capped(
                $now->addMinutes(self::VERIFIED_MINUTES[$attempts - 1] ?? 30),
                self::deadline($row->verified_at ?? $row->status_changed_at, (int) config('domains.ssl_window_hours', 24)),
                $now,
            ),
            StoreDomain::STATUS_SSL_PROVISIONING => self::capped(
                $row->status_changed_at !== null && $now->lessThan(CarbonImmutable::instance($row->status_changed_at)->addHour())
                    ? $now->addMinutes(2) : $now->addMinutes(15),
                self::deadline($row->status_changed_at, (int) config('domains.ssl_window_hours', 24)),
                $now,
            ),
            StoreDomain::STATUS_ACTIVE => $row->first_failed_at !== null ? $now->addHours(6) : self::daily($now),
            default => null,
        };
    }

    public static function daily(CarbonImmutable $now): CarbonImmutable
    {
        return $now->addHours(24)->addMinutes(random_int(-60, 60));
    }

    private static function deadline(?CarbonInterface $start, int $hours): ?CarbonImmutable
    {
        return $start === null ? null : CarbonImmutable::instance($start)->addHours($hours);
    }

    /** Never later than the deadline (so a timeout is noticed on time), never in the past. */
    private static function capped(CarbonImmutable $next, ?CarbonImmutable $deadline, CarbonImmutable $now): CarbonImmutable
    {
        if ($deadline !== null && $deadline->lessThan($next)) {
            return $deadline->greaterThan($now) ? $deadline : $now->addMinute();
        }

        return $next;
    }
}
