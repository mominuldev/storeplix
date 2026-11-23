<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;

/**
 * Per-merchant metrics (PHASE-8-2 §6.2, `view_merchants`): the `metrics` field of every AdminTenantSummary, the metric
 * sorts of `GET /admin/tenants`, and `GET /admin/tenants/{tenant}/metrics` (AdminTenantMetrics). Snapshot values as of
 * `as_of`; orders/GMV over the 30 days ending `as_of`. cross-tenant: platform analytics (B28).
 */
final class TenantMetrics
{
    public const SORTS = ['-mrr', 'mrr', '-gmv_30d', '-orders_30d', '-last_active_at', 'last_active_at'];

    /** Latest computed day (null before the first run). */
    public static function asOf(): ?string
    {
        $day = AnalyticsData::db()->table('platform_daily_metrics')->max('day');

        return $day === null ? null : substr((string) $day, 0, 10);
    }

    /**
     * AdminTenantMetricsSummary per tenant id; null when the tenant has no row on as_of (e.g. created today).
     *
     * @param  list<string>  $ids
     * @return array<string, array{as_of: string, mrr_amount: int, is_comp: bool, orders_30d: int, gmv_30d_amount: int}>
     */
    public static function summaries(array $ids, ?string $asOf): array
    {
        if ($ids === [] || $asOf === null) {
            return [];
        }
        $db = AnalyticsData::db();
        $at = $db->table('tenant_daily_metrics')->where('day', $asOf)->whereIn('tenant_id', $ids)
            ->get(['tenant_id', 'mrr_amount', 'is_comp'])->keyBy(fn ($r) => (string) $r->tenant_id);
        $flows = $db->table('tenant_daily_metrics')->whereIn('tenant_id', $ids)->whereBetween('day', [AnalyticsDays::add($asOf, -29), $asOf])
            ->groupBy('tenant_id')->selectRaw('tenant_id, coalesce(sum(orders_count), 0) as orders, coalesce(sum(gmv_amount), 0) as gmv')
            ->get()->keyBy(fn ($r) => (string) $r->tenant_id);

        $out = [];
        foreach ($at as $id => $row) {
            $out[$id] = [
                'as_of' => $asOf,
                'mrr_amount' => (int) $row->mrr_amount,
                'is_comp' => (bool) $row->is_comp,
                'orders_30d' => (int) ($flows->get($id)?->orders ?? 0),
                'gmv_30d_amount' => (int) ($flows->get($id)?->gmv ?? 0),
            ];
        }

        return $out;
    }

    /** Applies a metric sort (nulls last) to the merchants list query (`t` = tenants). */
    public static function sort(Builder $query, string $sort, ?string $asOf): void
    {
        $desc = str_starts_with($sort, '-');
        $direction = $desc ? 'desc' : 'asc';
        $column = ltrim($sort, '-');

        if ($column === 'last_active_at') {
            $query->orderByRaw('case when t.last_active_at is null then 1 else 0 end')->orderBy('t.last_active_at', $direction);

            return;
        }
        $day = $asOf ?? '1970-01-01';
        if ($column === 'mrr') {
            $query->leftJoin('tenant_daily_metrics as sm', function ($join) use ($day): void {
                $join->on('sm.tenant_id', '=', 't.id')->where('sm.day', '=', $day);
            });
            $query->orderByRaw('case when sm.mrr_amount is null then 1 else 0 end')->orderBy('sm.mrr_amount', $direction);

            return;
        }
        $sums = AnalyticsData::db()->table('tenant_daily_metrics')->whereBetween('day', [AnalyticsDays::add($day, -29), $day])
            ->groupBy('tenant_id')->selectRaw('tenant_id, sum(orders_count) as orders_30d, sum(gmv_amount) as gmv_30d');
        $query->leftJoinSub($sums, 'sf', 'sf.tenant_id', '=', 't.id');
        $field = $column === 'gmv_30d' ? 'sf.gmv_30d' : 'sf.orders_30d';
        $query->orderByRaw("case when {$field} is null then 1 else 0 end")->orderBy($field, $direction);
    }

    /**
     * AdminTenantMetrics for one tenant (30-day window ending as_of; previous = the 30 days before).
     *
     * @return array<string, mixed>
     */
    public static function detail(string $tenantId, ?string $asOf, string $anchor): array
    {
        $db = AnalyticsData::db();
        $row = $asOf === null ? null : $db->table('tenant_daily_metrics')->where('tenant_id', $tenantId)->where('day', $asOf)->first();
        $from = AnalyticsDays::add($anchor, -29);
        $window = self::flows($tenantId, $from, $anchor);
        $previous = self::flows($tenantId, AnalyticsDays::add($anchor, -59), AnalyticsDays::add($anchor, -30));
        $month = self::flows($tenantId, AnalyticsDays::firstOfMonth($anchor), $anchor);

        $firstMonth = AnalyticsDays::addMonths(AnalyticsDays::firstOfMonth($anchor), -11);
        $byMonth = [];
        $rows = $db->table('tenant_daily_metrics')->where('tenant_id', $tenantId)->whereBetween('day', [$firstMonth, $anchor])
            ->get(['day', 'orders_count', 'gmv_amount']);
        foreach ($rows as $r) {
            $m = AnalyticsDays::month(substr((string) $r->day, 0, 10));
            $byMonth[$m] ??= ['gmv' => 0, 'orders' => 0];
            $byMonth[$m]['gmv'] += (int) $r->gmv_amount;
            $byMonth[$m]['orders'] += (int) $r->orders_count;
        }
        $monthly = [];
        for ($k = 0; $k < 12; $k++) {
            $m = AnalyticsDays::month(AnalyticsDays::addMonths($firstMonth, $k));
            $monthly[] = ['month' => $m, 'gmv_amount' => $byMonth[$m]['gmv'] ?? null, 'orders_count' => $byMonth[$m]['orders'] ?? null];
        }

        $since = AnalyticsDays::startUtc(AnalyticsDays::add($anchor, -364));

        return [
            'mrr_amount' => $row !== null ? (int) $row->mrr_amount : null,
            'is_comp' => $row !== null && (bool) $row->is_comp,
            'plan_code' => $row?->plan_code !== null ? (string) $row->plan_code : null,
            'billing_interval' => $row?->billing_interval !== null ? (string) $row->billing_interval : null,
            'orders_30d' => $window['orders'] ?? null,
            'previous_orders_30d' => $previous['orders'] ?? null,
            'gmv_30d_amount' => $window['gmv'] ?? null,
            'previous_gmv_30d_amount' => $previous['gmv'] ?? null,
            'aov_30d_amount' => $window !== null && $window['orders'] > 0 ? intdiv($window['gmv'], $window['orders']) : null,
            'avg_orders_per_day_30d' => $window !== null ? round($window['orders'] / 30, 1) : null,
            'gmv_month_amount' => $month['gmv'] ?? null,
            'paid_12m_amount' => LiveBilling::paidTotals([$tenantId], CarbonImmutable::instance($since))[$tenantId] ?? 0,
            'monthly' => $monthly,
        ];
    }

    /** @return array{orders: int, gmv: int}|null null when no snapshot covers the window */
    private static function flows(string $tenantId, string $from, string $to): ?array
    {
        $r = AnalyticsData::db()->table('tenant_daily_metrics')->where('tenant_id', $tenantId)->whereBetween('day', [$from, $to])
            ->selectRaw('count(*) as n, coalesce(sum(orders_count), 0) as orders, coalesce(sum(gmv_amount), 0) as gmv')->first();

        return $r === null || (int) $r->n === 0 ? null : ['orders' => (int) $r->orders, 'gmv' => (int) $r->gmv];
    }
}
