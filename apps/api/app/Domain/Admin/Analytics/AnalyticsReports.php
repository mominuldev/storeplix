<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;

/**
 * PHASE-8-2 §6.2 bodies: `AdminAnalyticsOverview` (dashboard 15:123) and `AdminRevenueReport` (39:12705), from the
 * snapshot tables (+ the documented live fields). Stocks at `to` / `previous_to`, flows summed over the range.
 * cross-tenant: platform analytics (B28).
 */
final class AnalyticsReports
{
    /** @return array<string, mixed> AdminAnalyticsOverview */
    public static function overview(AnalyticsWindow $w, ?string $asOf): array
    {
        $windows = [[$w->from, $w->to], [$w->previousFrom, $w->previousTo]];
        $platform = AnalyticsData::platformRows([$w->to, $w->previousTo, (string) $asOf, ...array_column($w->buckets, 1), ...AnalyticsData::movementDays($windows)]);
        $mrr = AnalyticsData::tenantMrr(AnalyticsData::movementDays($windows));
        $now = AnalyticsData::movement($w->from, $w->to, $mrr, $platform);
        $before = AnalyticsData::movement($w->previousFrom, $w->previousTo, $mrr, $platform);
        $at = $platform[$w->to] ?? null;
        $prev = $platform[$w->previousTo] ?? null;
        $flows = AnalyticsData::flows($w->from, $w->to);
        $prevFlows = AnalyticsData::flows($w->previousFrom, $w->previousTo);
        $trial = LiveBilling::trialConversion($w->from, $w->to);
        $plans = self::plans();

        return [
            'mrr' => [
                'amount' => self::int($at?->mrr_amount),
                'previous_amount' => self::int($prev?->mrr_amount),
                'arr_amount' => $at !== null ? (int) $at->mrr_amount * 12 : null,
            ],
            'active_shops' => [
                'total' => self::int($at?->active_tenants),
                'paying' => self::int($at?->paying_tenants),
                'trialing' => self::int($at?->trialing_tenants),
                'comp' => self::int($at?->comp_tenants),
                'free' => self::int($at?->free_tenants),
                'past_due' => self::int($at?->past_due_tenants),
                'previous_total' => self::int($prev?->active_tenants),
            ],
            'trial_conversion' => [
                'rate' => $trial['rate'],
                'previous_rate' => LiveBilling::trialConversion($w->previousFrom, $w->previousTo)['rate'],
                'converted' => $trial['converted'],
                'ended' => $trial['ended'],
                'trialing_now' => $asOf !== null ? self::int(($platform[$asOf] ?? null)?->trialing_tenants) : null,
            ],
            'gmv' => [
                'amount' => $flows['gmv'] ?? null,
                'previous_amount' => $prevFlows['gmv'] ?? null,
                'orders_count' => $flows['orders'] ?? null,
                'previous_orders_count' => $prevFlows['orders'] ?? null,
                'aov_amount' => $flows !== null && $flows['orders'] > 0 ? intdiv($flows['gmv'], $flows['orders']) : null,
            ],
            'revenue_churn' => [
                'rate' => AnalyticsDays::rate($now['churned'], $now['opening']),
                'previous_rate' => AnalyticsDays::rate($before['churned'], $before['opening']),
                'churned_amount' => $now['churned'],
                'cancellations' => $now['counts']['churned'] ?? null,
                'opening_mrr_amount' => $now['opening'],
            ],
            'mrr_series' => array_map(function (array $b) use ($platform) {
                $row = $platform[$b[1]] ?? null;

                return [
                    'bucket_start' => $b[0],
                    'bucket_end' => $b[1],
                    'mrr_amount' => self::int($row?->mrr_amount),
                    'by_plan' => (object) ($row?->mrr_by_plan ?? []),
                ];
            }, $w->buckets),
            'plan_mix' => $at === null ? [] : array_map(fn (object $p) => [
                'plan_code' => (string) $p->code,
                'plan_name' => (string) $p->name,
                'count' => (int) ($at->tenants_by_plan[(string) $p->code] ?? 0),
            ], $plans),
            'plans' => array_map(fn (object $p) => [
                'code' => (string) $p->code, 'name' => (string) $p->name, 'sort' => (int) $p->sort, 'monthly_price_amount' => (int) $p->price_amount,
            ], $plans),
        ];
    }

    /** @return array<string, mixed> AdminRevenueReport */
    public static function revenue(AnalyticsWindow $w, ?string $asOf): array
    {
        $anchor = $asOf ?? $w->to;
        $ltvMonths = [];
        for ($k = 3; $k >= 1; $k--) {
            $first = AnalyticsDays::addMonths(AnalyticsDays::firstOfMonth($anchor), -$k);
            $ltvMonths[] = [$first, AnalyticsDays::lastOfMonth($first)];
        }
        $windows = [[$w->from, $w->to], [$w->previousFrom, $w->previousTo], ...$w->buckets, ...$ltvMonths];
        $platform = AnalyticsData::platformRows([$w->to, $w->previousTo, ...AnalyticsData::movementDays($windows)]);
        $mrr = AnalyticsData::tenantMrr(AnalyticsData::movementDays($windows));
        $now = AnalyticsData::movement($w->from, $w->to, $mrr, $platform);
        $before = AnalyticsData::movement($w->previousFrom, $w->previousTo, $mrr, $platform);
        $at = $platform[$w->to] ?? null;
        $prev = $platform[$w->previousTo] ?? null;
        $arpa = $at !== null && (int) $at->paying_tenants > 0 ? intdiv((int) $at->mrr_amount, (int) $at->paying_tenants) : null;

        // P82-8 LTV: ARPA × min(60, round(1 / mean revenue churn of the last 3 complete months, 1)).
        $churns = array_map(function (array $m) use ($mrr, $platform) {
            $mv = AnalyticsData::movement($m[0], $m[1], $mrr, $platform);

            return $mv['opening'] !== null && $mv['opening'] > 0 ? $mv['churned'] / $mv['opening'] : null;
        }, $ltvMonths);
        $lifetime = null;
        if (! in_array(null, $churns, true) && array_sum($churns) > 0) {
            $lifetime = min(60.0, round(1 / (array_sum($churns) / 3), 1));
        }

        return [
            'kpis' => [
                'mrr' => ['amount' => self::int($at?->mrr_amount), 'previous_amount' => self::int($prev?->mrr_amount)],
                'arr' => [
                    'amount' => $at !== null ? (int) $at->mrr_amount * 12 : null,
                    'previous_amount' => $prev !== null ? (int) $prev->mrr_amount * 12 : null,
                ],
                'net_new_mrr' => [
                    'amount' => $now['net_new'], 'previous_amount' => $before['net_new'],
                    'new_amount' => $now['new'], 'expansion_amount' => $now['expansion'],
                    'contraction_amount' => $now['contraction'], 'churned_amount' => $now['churned'],
                ],
                'churned_mrr' => [
                    'amount' => $now['churned'], 'previous_amount' => $before['churned'],
                    'rate' => AnalyticsDays::rate($now['churned'], $now['opening']),
                    'previous_rate' => AnalyticsDays::rate($before['churned'], $before['opening']),
                    'opening_mrr_amount' => $now['opening'], 'count' => $now['counts']['churned'] ?? null,
                ],
                'arpa' => [
                    'amount' => $arpa,
                    'previous_amount' => $prev !== null && (int) $prev->paying_tenants > 0 ? intdiv((int) $prev->mrr_amount, (int) $prev->paying_tenants) : null,
                    'paying' => self::int($at?->paying_tenants),
                ],
                'ltv' => [
                    'amount' => $arpa !== null && $lifetime !== null ? intdiv($arpa * (int) round($lifetime * 10), 10) : null, // exact: lifetime has 1 decimal
                    'lifetime_months' => $lifetime,
                ],
            ],
            'movement' => array_map(function (array $b) use ($mrr, $platform) {
                $mv = AnalyticsData::movement($b[0], $b[1], $mrr, $platform);

                return [
                    'bucket_start' => $b[0], 'bucket_end' => $b[1],
                    'opening_mrr_amount' => $mv['opening'], 'new_amount' => $mv['new'], 'expansion_amount' => $mv['expansion'],
                    'contraction_amount' => $mv['contraction'], 'churned_amount' => $mv['churned'], 'net_new_amount' => $mv['net_new'],
                    'closing_mrr_amount' => $mv['closing'], 'counts' => $mv['counts'],
                ];
            }, $w->buckets),
            'cohorts' => $asOf === null ? ['rows' => [], 'm3_average' => null] : self::cohorts($asOf),
            'by_plan' => self::byPlan($at, $prev),
            'trial_funnel' => LiveBilling::funnel($w->from, $w->to, $anchor),
            'top_merchants' => $at === null ? [] : self::topMerchants($w->to),
        ];
    }

    /**
     * P82-14: cohort = Dhaka month of the first paid invoice; retention[k] = share with MRR > 0 on the last day of
     * month cohort+k (current month: as_of); null without a snapshot that day. The 12 months ending with as_of's month.
     *
     * @return array{rows: list<array{cohort: string, size: int, retention: list<float|null>}>, m3_average: float|null}
     */
    public static function cohorts(string $asOf): array
    {
        $current = AnalyticsDays::firstOfMonth($asOf);
        $months = [];
        for ($k = 11; $k >= 0; $k--) {
            $months[] = AnalyticsDays::addMonths($current, -$k);
        }
        $members = array_fill_keys(array_map(fn ($m) => AnalyticsDays::month($m), $months), []);
        foreach (LiveBilling::firstPaid() as $tenant => $paidAt) {
            $month = AnalyticsDays::month((string) AnalyticsDays::dayOf($paidAt));
            if (isset($members[$month]) && $paidAt->lt(AnalyticsDays::endUtc($asOf))) {
                $members[$month][] = $tenant;
            }
        }

        $dayFor = fn (string $first): string => $first === $current ? $asOf : AnalyticsDays::lastOfMonth($first);
        $days = array_map($dayFor, $months);
        $platform = AnalyticsData::platformRows($days);
        $mrr = AnalyticsData::tenantMrr($days);

        $rows = [];
        $weighted = 0.0;
        $weight = 0;
        foreach ($months as $i => $first) {
            $cohort = $members[AnalyticsDays::month($first)];
            $retention = [];
            for ($k = 0; $i + $k < count($months); $k++) {
                $day = $days[$i + $k];
                if (! isset($platform[$day]) || $cohort === []) {
                    $retention[] = null;

                    continue;
                }
                $retained = count(array_intersect_key($mrr[$day] ?? [], array_flip($cohort)));
                $retention[] = AnalyticsDays::rate($retained, count($cohort));
            }
            if (isset($retention[3]) && $retention[3] !== null) {
                $weighted += $retention[3] * count($cohort);
                $weight += count($cohort);
            }
            $rows[] = ['cohort' => AnalyticsDays::month($first), 'size' => count($cohort), 'retention' => $retention];
        }

        return ['rows' => $rows, 'm3_average' => $weight > 0 ? round($weighted / $weight, 4) : null];
    }

    /** @return array{rows: list<array<string, mixed>>, total: array<string, int|null>} */
    private static function byPlan(?object $at, ?object $prev): array
    {
        $rows = [];
        $total = $at !== null ? (int) $at->mrr_amount : null;
        foreach (array_reverse(self::plans()) as $p) {
            $code = (string) $p->code;
            $free = $code === Plan::FREE;
            $shops = $at === null ? null : ($free ? (int) $at->free_tenants : (int) ($at->paying_by_plan[$code] ?? 0));
            $planMrr = $at === null ? null : ($free ? 0 : (int) ($at->mrr_by_plan[$code] ?? 0));
            $rows[] = [
                'plan_code' => $code,
                'plan_name' => (string) $p->name,
                'monthly_price_amount' => (int) $p->price_amount,
                'shops' => $shops,
                'mrr_amount' => $planMrr,
                'previous_mrr_amount' => $prev === null ? null : ($free ? 0 : (int) ($prev->mrr_by_plan[$code] ?? 0)),
                'share' => $at === null ? null : ($free ? 0.0 : AnalyticsDays::rate($planMrr, $total)),
                'yearly_share' => $free || $at === null ? null : AnalyticsDays::rate((int) ($at->yearly_by_plan[$code] ?? 0), $shops),
            ];
        }

        return ['rows' => $rows, 'total' => [
            'shops' => $at === null ? null : array_sum(array_column($rows, 'shops')),
            'paying' => $at === null ? null : (int) $at->paying_tenants,
            'mrr_amount' => $total,
            'previous_mrr_amount' => $prev !== null ? (int) $prev->mrr_amount : null,
        ]];
    }

    /**
     * ≤ 10 paying shops on `$day` by MRR desc, then lifetime paid desc, then name.
     *
     * @return list<array<string, mixed>> TopPayingMerchant
     */
    private static function topMerchants(string $day): array
    {
        $db = AnalyticsData::db();
        $ranked = $db->table('tenant_daily_metrics')->where('day', $day)->where('mrr_amount', '>', 0)
            ->orderByDesc('mrr_amount')->limit(10)->pluck('mrr_amount');
        if ($ranked->isEmpty()) {
            return [];
        }
        // Every shop tied with the 10th MRR value, so the lifetime-paid tie-break is exact.
        $rows = $db->table('tenant_daily_metrics')->where('day', $day)->where('mrr_amount', '>=', (int) $ranked->last())
            ->get(['tenant_id', 'mrr_amount', 'plan_code', 'billing_interval'])->keyBy(fn ($r) => (string) $r->tenant_id);
        $ids = $rows->keys()->all();
        $lifetime = LiveBilling::paidTotals($ids);
        $firstPaid = LiveBilling::firstPaid($ids);
        $refs = AdminPresenter::shopRefs($ids);
        $hosts = collect(TenantDirectory::primaryHosts($ids));
        $providers = [];
        foreach ($db->table('billing_invoices as i')
            ->leftJoin('billing_payments as bp', function ($join): void {
                $join->on('bp.id', '=', 'i.paid_payment_id')->on('bp.tenant_id', '=', 'i.tenant_id');
            })
            ->whereIn('i.tenant_id', $ids)->where('i.status', BillingInvoice::PAID)->orderBy('i.paid_at')->orderBy('i.id')
            ->get(['i.tenant_id', 'bp.provider']) as $inv) {
            $providers[(string) $inv->tenant_id] = $inv->provider !== null ? (string) $inv->provider : null; // latest wins
        }
        $since = AnalyticsDays::add($day, -29);
        $orders = $db->table('tenant_daily_metrics')->whereIn('tenant_id', $ids)->whereBetween('day', [$since, $day])
            ->groupBy('tenant_id')->selectRaw('tenant_id, coalesce(sum(orders_count), 0) as n')->pluck('n', 'tenant_id');

        $list = $rows->map(fn ($r, string $id) => [
            'tenant' => $refs[$id] ?? ['id' => $id, 'name' => '', 'slug' => ''],
            'primary_host' => $hosts->get($id),
            'plan_code' => (string) $r->plan_code,
            'billing_interval' => $r->billing_interval !== null ? (string) $r->billing_interval : null,
            'last_payment_provider' => $providers[$id] ?? null,
            'orders_30d' => (int) ($orders[$id] ?? 0),
            'mrr_amount' => (int) $r->mrr_amount,
            'customer_since' => isset($firstPaid[$id]) ? AnalyticsDays::dayOf($firstPaid[$id]) : null,
            'lifetime_paid_amount' => $lifetime[$id] ?? 0,
        ])->values()->all();

        usort($list, fn (array $a, array $b) => [$b['mrr_amount'], $b['lifetime_paid_amount'], $a['tenant']['name']]
            <=> [$a['mrr_amount'], $a['lifetime_paid_amount'], $b['tenant']['name']]);

        return array_slice($list, 0, 10);
    }

    /** @return list<object> plans ordered by `sort` */
    public static function plans(): array
    {
        return AnalyticsData::db()->table('plans')->orderBy('sort')->orderBy('code')->get(['code', 'name', 'sort', 'price_amount'])->all();
    }

    private static function int(mixed $value): ?int
    {
        return $value === null ? null : (int) $value;
    }
}
