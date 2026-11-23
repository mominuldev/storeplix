<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Tenancy\Support\PlatformDb;
use Carbon\CarbonImmutable;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\Cache;
use RuntimeException;

/**
 * Read side of the snapshot tables (PHASE-8-2 §6, P82-9, P82-19) on the admin connection. Every analytics response reads
 * only `platform_daily_metrics`, `tenant_daily_metrics`, `plans` and the few documented live billing/tenant fields.
 * cross-tenant: platform analytics (B28).
 */
final class AnalyticsData
{
    public static function db(): ConnectionInterface
    {
        return PlatformDb::connection(); // cross-tenant: platform analytics
    }

    /**
     * Runs request-path reads in one read transaction with `statement_timeout` 15 s (Postgres).
     *
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    public static function read(callable $callback): mixed
    {
        $db = self::db();
        if ($db->getDriverName() !== 'pgsql') {
            return $callback();
        }

        return $db->transaction(function () use ($db, $callback) {
            $db->statement("SET LOCAL statement_timeout = '15s'");

            return $callback();
        });
    }

    /** @return array{as_of: string|null, computed_at: string|null, data_starts_on: string|null} */
    public static function state(): array
    {
        $row = self::db()->table('platform_daily_metrics')
            ->selectRaw('max(day) as as_of, min(day) as starts, max(computed_at) as computed_at')->first();

        return [
            'as_of' => $row?->as_of !== null ? substr((string) $row->as_of, 0, 10) : null,
            'computed_at' => $row?->computed_at !== null ? self::ts($row->computed_at) : null,
            'data_starts_on' => $row?->starts !== null ? substr((string) $row->starts, 0, 10) : null,
        ];
    }

    /**
     * P82-19: cached per endpoint + params + as_of + computed_at (a night run or restatement changes the key).
     *
     * @template T
     *
     * @param  array<string, mixed>  $params
     * @param  array{as_of: string|null, computed_at: string|null, data_starts_on: string|null}  $state
     * @param  callable(): T  $callback
     * @return T
     */
    public static function cached(string $endpoint, array $params, array $state, callable $callback): mixed
    {
        ksort($params);
        $key = 'sp:analytics:'.$endpoint.':'.sha1((string) json_encode($params)).':'.($state['as_of'] ?? 'none').':'.($state['computed_at'] ?? 'none');

        return Cache::remember($key, max(1, (int) config('analytics.cache_seconds', 3600)), $callback);
    }

    /**
     * Platform rows for the given days (JSON maps decoded), keyed by day.
     *
     * @param  list<string>  $days
     * @return array<string, object>
     */
    public static function platformRows(array $days): array
    {
        $days = array_values(array_unique(array_filter($days)));
        if ($days === []) {
            return [];
        }
        $out = [];
        foreach (self::db()->table('platform_daily_metrics')->whereIn('day', $days)->get() as $row) {
            foreach (['mrr_by_plan', 'tenants_by_plan', 'paying_by_plan', 'yearly_by_plan'] as $map) {
                $decoded = is_string($row->{$map}) ? json_decode($row->{$map}, true) : $row->{$map};
                $row->{$map} = is_array($decoded) ? array_map('intval', $decoded) : [];
            }
            $out[substr((string) $row->day, 0, 10)] = $row;
        }

        return $out;
    }

    /**
     * Flow totals over [$from, $to] from the platform rows; null when no row covers the window.
     *
     * @return array{orders: int, gmv: int, days: int}|null
     */
    public static function flows(string $from, string $to): ?array
    {
        $row = self::db()->table('platform_daily_metrics')->whereBetween('day', [$from, $to])
            ->selectRaw('count(*) as n, coalesce(sum(orders_count), 0) as orders, coalesce(sum(gmv_amount), 0) as gmv')->first();

        return $row === null || (int) $row->n === 0 ? null : ['orders' => (int) $row->orders, 'gmv' => (int) $row->gmv, 'days' => (int) $row->n];
    }

    /**
     * Per-tenant MRR (> 0 only) on the given days.
     *
     * @param  list<string>  $days
     * @return array<string, array<string, int>> day → tenant id → mrr
     */
    public static function tenantMrr(array $days): array
    {
        $days = array_values(array_unique(array_filter($days)));
        $out = array_fill_keys($days, []);
        if ($days === []) {
            return $out;
        }
        $rows = self::db()->table('tenant_daily_metrics')->whereIn('day', $days)->where('mrr_amount', '>', 0)
            ->get(['tenant_id', 'day', 'mrr_amount']);
        foreach ($rows as $r) {
            $out[substr((string) $r->day, 0, 10)][(string) $r->tenant_id] = (int) $r->mrr_amount;
        }

        return $out;
    }

    /**
     * P82-9 MRR movement of the window [$a, $b]: per tenant `open` = MRR on a − 1, `close` = MRR on b. Null money
     * (and null counts) when either day has no platform row (before `data_starts_on`, or a gap).
     *
     * @param  array<string, array<string, int>>  $mrr  day → tenant → mrr (from tenantMrr())
     * @param  array<string, object>  $platform  day → platform row
     * @return array{opening: int|null, closing: int|null, new: int|null, expansion: int|null, contraction: int|null, churned: int|null, net_new: int|null, opening_paying: int|null, counts: array{new: int, expansion: int, contraction: int, churned: int}|null}
     */
    public static function movement(string $a, string $b, array $mrr, array $platform): array
    {
        $open = AnalyticsDays::add($a, -1);
        if (! isset($platform[$open], $platform[$b])) {
            return ['opening' => null, 'closing' => null, 'new' => null, 'expansion' => null, 'contraction' => null,
                'churned' => null, 'net_new' => null, 'opening_paying' => null, 'counts' => null];
        }
        $o = $mrr[$open] ?? [];
        $c = $mrr[$b] ?? [];
        $m = ['new' => 0, 'expansion' => 0, 'contraction' => 0, 'churned' => 0];
        $n = ['new' => 0, 'expansion' => 0, 'contraction' => 0, 'churned' => 0];
        foreach (array_keys($o + $c) as $tenant) {
            $before = $o[$tenant] ?? 0;
            $after = $c[$tenant] ?? 0;
            $kind = match (true) {
                $before === 0 && $after > 0 => 'new',
                $before > 0 && $after === 0 => 'churned',
                $before > 0 && $after > $before => 'expansion',
                $after > 0 && $after < $before => 'contraction',
                default => null,
            };
            if ($kind !== null) {
                $m[$kind] += abs($after - $before);
                $n[$kind]++;
            }
        }
        $opening = array_sum($o);
        $closing = array_sum($c);
        $net = $m['new'] + $m['expansion'] - $m['contraction'] - $m['churned'];
        if ($net !== $closing - $opening) {
            throw new RuntimeException("analytics movement {$a}..{$b}: net new {$net} != closing − opening");
        }

        return ['opening' => $opening, 'closing' => $closing] + $m + ['net_new' => $net, 'opening_paying' => count($o), 'counts' => $n];
    }

    /**
     * Days needed by movement() for these windows.
     *
     * @param  list<array{0: string, 1: string}>  $windows
     * @return list<string>
     */
    public static function movementDays(array $windows): array
    {
        $days = [];
        foreach ($windows as [$a, $b]) {
            $days[] = AnalyticsDays::add($a, -1);
            $days[] = $b;
        }

        return array_values(array_unique($days));
    }

    /** @return array{as_of: string|null, computed_at: string|null, data_starts_on: string|null, timezone: string, currency: string} */
    public static function meta(array $state): array
    {
        return $state + ['timezone' => AnalyticsDays::tz(), 'currency' => 'BDT'];
    }

    public static function ts(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return CarbonImmutable::parse((string) $value, 'UTC')->utc()->toIso8601ZuluString();
    }
}
