<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-2 P82-17: a range (`30d` | `quarter` | `12m` | `custom`) resolved against the as-of day, its previous period
 * and its buckets (`day` | `week` (ISO, Monday start) | `month`), clipped to the range. Without data the anchor is
 * yesterday (Dhaka).
 */
final class AnalyticsWindow
{
    public const RANGES = ['30d', 'quarter', '12m', 'custom'];

    public const GRANULARITIES = ['day', 'week', 'month'];

    public const MIN_FROM = '2024-01-01';

    public const MAX_DAYS = 731;

    /** Maximum number of buckets per granularity (over → 422). */
    public const CAPS = ['day' => 92, 'week' => 106, 'month' => 25];

    /** @param list<array{0: string, 1: string}> $buckets */
    private function __construct(
        public readonly string $range,
        public readonly string $granularity,
        public readonly string $from,
        public readonly string $to,
        public readonly string $previousFrom,
        public readonly string $previousTo,
        public readonly array $buckets,
    ) {}

    /**
     * @param  array{range?: string|null, from?: string|null, to?: string|null, granularity?: string|null}  $input  validated
     *
     * @throws ValidationException
     */
    public static function resolve(array $input, ?string $asOf, string $defaultRange): self
    {
        $anchor = $asOf ?? AnalyticsDays::add(AnalyticsDays::today(), -1);
        $range = (string) ($input['range'] ?? $defaultRange);

        [$from, $to] = match ($range) {
            '30d' => [AnalyticsDays::add($anchor, -29), $anchor],
            'quarter' => [AnalyticsDays::add($anchor, -89), $anchor],
            '12m' => [AnalyticsDays::addMonths(AnalyticsDays::firstOfMonth($anchor), -11), $anchor],
            default => [(string) $input['from'], min((string) $input['to'], $anchor)],
        };

        $days = AnalyticsDays::diff($from, $to) + 1;
        if ($range === 'custom') {
            if ($from > $to) {
                throw ValidationException::withMessages(['from' => ['The from date must be on or before the to date (to is clamped to the latest computed day).']]);
            }
            if ($days > self::MAX_DAYS) {
                throw ValidationException::withMessages(['from' => ['A custom range spans at most '.self::MAX_DAYS.' days.']]);
            }
        }

        $granularity = $input['granularity'] ?? null;
        $granularity = is_string($granularity) && $granularity !== '' ? $granularity : match ($range) {
            '30d' => 'day',
            'quarter' => 'week',
            '12m' => 'month',
            default => $days <= 31 ? 'day' : ($days <= 92 ? 'week' : 'month'),
        };

        $buckets = self::buckets($from, $to, $granularity);
        if (count($buckets) > self::CAPS[$granularity]) {
            throw ValidationException::withMessages(['granularity' => ["Too many {$granularity} buckets for this range (at most ".self::CAPS[$granularity].').']]);
        }

        if ($range === '12m') {
            $previousFrom = AnalyticsDays::addMonths($from, -12);
        } else {
            $previousFrom = AnalyticsDays::add($from, -$days);
        }

        return new self($range, $granularity, $from, $to, $previousFrom, AnalyticsDays::add($from, -1), $buckets);
    }

    /** @return list<array{0: string, 1: string}> [start, end] per bucket, clipped to [$from, $to] */
    public static function buckets(string $from, string $to, string $granularity): array
    {
        $out = [];
        $start = $from;
        $guard = 0;
        while ($start <= $to && $guard++ < 1000) {
            $end = match ($granularity) {
                'day' => $start,
                'week' => AnalyticsDays::add($start, 7 - AnalyticsDays::isoWeekday($start)),
                default => AnalyticsDays::lastOfMonth($start),
            };
            $end = min($end, $to);
            $out[] = [$start, $end];
            $start = AnalyticsDays::add($end, 1);
        }

        return $out;
    }

    /** @return array<string, mixed> openapi AnalyticsMeta minus the data fields */
    public function meta(): array
    {
        return [
            'range' => $this->range,
            'granularity' => $this->granularity,
            'from' => $this->from,
            'to' => $this->to,
            'previous_from' => $this->previousFrom,
            'previous_to' => $this->previousTo,
        ];
    }
}
