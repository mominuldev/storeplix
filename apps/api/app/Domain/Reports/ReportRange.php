<?php

declare(strict_types=1);

namespace App\Domain\Reports;

use Carbon\CarbonImmutable;
use Illuminate\Validation\ValidationException;

/**
 * A report range (PHASE-7-CONTRACT P7-18, §6.3): store-local dates `from`..`to` inclusive in the store timezone.
 * Defaults: 1st of the current local month → today. `to` after today is clipped to today; span ≤ 366 days.
 * `previous` is the equal-length period immediately before.
 */
final class ReportRange
{
    public const MAX_DAYS = 366;

    public const MIN_DATE = '2020-01-01';

    private function __construct(
        public readonly CarbonImmutable $from,   // local midnight of the first day
        public readonly CarbonImmutable $to,     // local midnight of the last day
        public readonly string $timezone,
        public readonly CarbonImmutable $today,  // local midnight of today
    ) {}

    public static function resolve(?string $from, ?string $to, string $timezone): self
    {
        $today = CarbonImmutable::now($timezone)->startOfDay();
        $toDate = $to !== null ? CarbonImmutable::createFromFormat('!Y-m-d', $to, $timezone) : $today;
        if ($toDate->greaterThan($today)) {
            $toDate = $today;
        }
        $fromDate = $from !== null
            ? CarbonImmutable::createFromFormat('!Y-m-d', $from, $timezone)
            : $toDate->startOfMonth();

        if ($fromDate->greaterThan($toDate)) {
            throw ValidationException::withMessages(['from' => ['The start date must be on or before the end date (and not in the future).']]);
        }
        if ($fromDate->diffInDays($toDate) + 1 > self::MAX_DAYS) {
            throw ValidationException::withMessages(['to' => ['A report covers at most '.self::MAX_DAYS.' days.']]);
        }

        return new self($fromDate, $toDate, $timezone, $today);
    }

    /** Number of local days in the range (inclusive). */
    public function days(): int
    {
        return (int) $this->from->diffInDays($this->to) + 1;
    }

    /** Days from `from` to min(to, today), inclusive (the range is already clipped to today). */
    public function elapsedDays(): int
    {
        return $this->days();
    }

    public function previous(): self
    {
        $to = $this->from->subDay();

        return new self($to->subDays($this->days() - 1), $to, $this->timezone, $this->today);
    }

    /** UTC instant of the start of `from` (inclusive). */
    public function startUtc(): CarbonImmutable
    {
        return $this->from->utc();
    }

    /** UTC instant of the end of `to` (exclusive: next local midnight). */
    public function endUtc(): CarbonImmutable
    {
        return $this->to->addDay()->utc();
    }

    /** @return list<string> every local date Y-m-d in the range, oldest first */
    public function dates(): array
    {
        $out = [];
        for ($d = $this->from; $d->lessThanOrEqualTo($this->to); $d = $d->addDay()) {
            $out[] = $d->format('Y-m-d');
        }

        return $out;
    }

    /**
     * The $count ISO weeks (Monday start) ending with the week of `to`.
     *
     * @return list<array{week: string, week_start: string}>
     */
    public function isoWeeks(int $count): array
    {
        $last = $this->to->startOfWeek(CarbonImmutable::MONDAY);
        $out = [];
        for ($i = $count - 1; $i >= 0; $i--) {
            $start = $last->subWeeks($i);
            $out[] = ['week' => $start->format('o-\WW'), 'week_start' => $start->format('Y-m-d')];
        }

        return $out;
    }

    /** UTC [start, end) of the $count ISO weeks ending with the week of `to`. @return array{0: CarbonImmutable, 1: CarbonImmutable} */
    public function weeksWindowUtc(int $count): array
    {
        $last = $this->to->startOfWeek(CarbonImmutable::MONDAY);

        return [$last->subWeeks($count - 1)->utc(), $last->addWeek()->utc()];
    }

    /** @var array<string, string> 15-minute UTC bucket → local label (memo, see local()) */
    private array $memo = [];

    private ?\DateTimeZone $utcZone = null;

    /** @var array<string, int> "Y-m-d H|offset" → UTC timestamp of that hour (memo, see local()) */
    private array $hourTs = [];

    private ?\DateTimeZone $zone = null;

    /** @var array<int, int|false> UTC hour → zone offset in seconds, false if it changes inside the hour (memo) */
    private array $hourOffset = [];

    /** @var array<string, string> format|local day number → label (memo) */
    private array $dayLabel = [];

    /** Local date (Y-m-d) of a stored UTC timestamp. */
    public function localDate(mixed $value): string
    {
        return $this->local($value, 'Y-m-d');
    }

    /** ISO week label (YYYY-Www) of a stored UTC timestamp in the store timezone. */
    public function localWeek(mixed $value): string
    {
        return $this->local($value, 'o-\WW');
    }

    /**
     * Perf (366-day reports over 50k orders): every real UTC offset is a multiple of 15 minutes, so the local date / ISO
     * week is constant inside a 15-minute UTC bucket. Each bucket is converted once with Carbon and then memoised.
     */
    private function local(mixed $value, string $format): string
    {
        if ($value instanceof \DateTimeInterface) {
            $ts = $value->getTimestamp();
        } elseif (is_string($value) && strlen($value) >= 19 && $value[10] === ' ' && $value[13] === ':' && $value[16] === ':'
            && ctype_digit(substr($value, 14, 2).substr($value, 17, 2))) {
            // DB string "Y-m-d H:i:s[.u][offset]": parse once per distinct hour (+ offset suffix), then add minutes and
            // seconds arithmetically. Exact (fractions are ignored, as getTimestamp() does) and ~6x fewer parses.
            $this->utcZone ??= new \DateTimeZone('UTC');
            $suffix = ltrim(substr($value, 19), '.0123456789');
            $hour = substr($value, 0, 13).'|'.$suffix;
            $base = $this->hourTs[$hour] ??= (new \DateTimeImmutable(substr($value, 0, 13).':00:00'.$suffix, $this->utcZone))->getTimestamp();
            $ts = $base + 60 * (int) substr($value, 14, 2) + (int) substr($value, 17, 2);
        } else {
            $this->utcZone ??= new \DateTimeZone('UTC');
            $ts = (new \DateTimeImmutable((string) $value, $this->utcZone))->getTimestamp();
        }
        // Date-only formats: shift by the zone offset of the UTC hour (looked up once per hour, used only when it is the
        // same at both ends of the hour, i.e. no transition inside it) and format the local day once with gmdate().
        if ($format === 'Y-m-d' || $format === 'o-\\WW') {
            $hour = intdiv($ts, 3600) - ($ts < 0 && $ts % 3600 !== 0 ? 1 : 0);
            $offset = $this->hourOffset[$hour] ??= $this->stableOffset($hour * 3600);
            if ($offset !== false) {
                $local = $ts + $offset;
                $day = intdiv($local, 86400) - ($local < 0 && $local % 86400 !== 0 ? 1 : 0);

                return $this->dayLabel[$format.'|'.$day] ??= gmdate($format, $day * 86400);
            }
        }
        $bucket = intdiv($ts, 900) - ($ts < 0 && $ts % 900 !== 0 ? 1 : 0);
        $key = $format.'|'.$bucket;

        return $this->memo[$key] ??= CarbonImmutable::createFromTimestampUTC($bucket * 900)->setTimezone($this->timezone)->format($format);
    }

    /** Zone offset (seconds) for the UTC hour starting at $start, or false when it changes inside that hour. */
    private function stableOffset(int $start): int|false
    {
        $this->zone ??= new \DateTimeZone($this->timezone);
        $a = $this->zone->getOffset(new \DateTimeImmutable('@'.$start));

        return $a === $this->zone->getOffset(new \DateTimeImmutable('@'.($start + 3599))) ? $a : false;
    }

    public static function parse(mixed $value): CarbonImmutable
    {
        return $value instanceof \DateTimeInterface ? CarbonImmutable::instance($value)->utc() : CarbonImmutable::parse((string) $value, 'UTC')->utc();
    }

    /** ReportMeta (without generated_at). @return array<string, string> */
    public function meta(string $currency): array
    {
        $previous = $this->previous();

        return [
            'from' => $this->from->format('Y-m-d'),
            'to' => $this->to->format('Y-m-d'),
            'previous_from' => $previous->from->format('Y-m-d'),
            'previous_to' => $previous->to->format('Y-m-d'),
            'timezone' => $this->timezone,
            'currency' => $currency,
        ];
    }

    public function cacheHash(string $storeId): string
    {
        return sha1($storeId.'|'.$this->from->format('Y-m-d').'|'.$this->to->format('Y-m-d').'|'.$this->timezone);
    }
}
