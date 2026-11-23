<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Billing\Models\BillingInvoice;
use Carbon\CarbonImmutable;

/**
 * The documented **live** analytics reads (PHASE-8-2 §3): first paid date, lifetime paid, trial ends, trial → paid
 * (P82-13) and the trial funnel (P82-15), from `subscriptions`, `billing_invoices`, `tenants` and `stores` on the
 * admin connection. "Non-duplicate paid invoice" = `billing_invoices.status = 'paid'` (§3).
 * cross-tenant: platform analytics (B28).
 */
final class LiveBilling
{
    /**
     * First paid invoice per tenant (UTC instant), optionally limited to some tenants.
     *
     * @param  list<string>|null  $tenantIds
     * @return array<string, CarbonImmutable>
     */
    public static function firstPaid(?array $tenantIds = null): array
    {
        if ($tenantIds === []) {
            return [];
        }
        $query = AnalyticsData::db()->table('billing_invoices')->where('status', BillingInvoice::PAID)->whereNotNull('paid_at')
            ->groupBy('tenant_id')->selectRaw('tenant_id, min(paid_at) as first_paid');
        if ($tenantIds !== null) {
            $query->whereIn('tenant_id', $tenantIds);
        }
        $out = [];
        foreach ($query->get() as $row) {
            $out[(string) $row->tenant_id] = CarbonImmutable::parse((string) $row->first_paid, 'UTC')->utc();
        }

        return $out;
    }

    /**
     * Σ total_amount of paid invoices per tenant (optionally only paid at or after $since).
     *
     * @param  list<string>  $tenantIds
     * @return array<string, int>
     */
    public static function paidTotals(array $tenantIds, ?CarbonImmutable $since = null): array
    {
        if ($tenantIds === []) {
            return [];
        }
        $query = AnalyticsData::db()->table('billing_invoices')->where('status', BillingInvoice::PAID)->whereIn('tenant_id', $tenantIds)
            ->groupBy('tenant_id')->selectRaw('tenant_id, coalesce(sum(total_amount), 0) as total');
        if ($since !== null) {
            $query->where('paid_at', '>=', $since->utc());
        }

        return $query->pluck('total', 'tenant_id')->map(fn ($v) => (int) $v)->all();
    }

    /**
     * Trial end per tenant = min non-null `trial_ends_at` over the tenant's subscription rows.
     *
     * @param  list<string>|null  $tenantIds
     * @return array<string, CarbonImmutable>
     */
    public static function trialEnds(?array $tenantIds = null, ?string $fromDay = null, ?string $toDay = null): array
    {
        if ($tenantIds === []) {
            return [];
        }
        $query = AnalyticsData::db()->table('subscriptions')->whereNotNull('trial_ends_at')
            ->groupBy('tenant_id')->selectRaw('tenant_id, min(trial_ends_at) as trial_end');
        if ($tenantIds !== null) {
            $query->whereIn('tenant_id', $tenantIds);
        }
        if ($fromDay !== null && $toDay !== null) {
            $query->havingRaw('min(trial_ends_at) >= ? and min(trial_ends_at) < ?', [AnalyticsDays::startUtc($fromDay), AnalyticsDays::endUtc($toDay)]);
        }
        $out = [];
        foreach ($query->get() as $row) {
            $out[(string) $row->tenant_id] = CarbonImmutable::parse((string) $row->trial_end, 'UTC')->utc();
        }

        return $out;
    }

    /**
     * P82-13 for trials that ended in [$from, $to] (Dhaka days; $to ≤ as_of): converted = first paid invoice at or
     * before trial end + ANALYTICS_TRIAL_CONVERSION_DAYS.
     *
     * @return array{rate: float|null, converted: int, ended: int}
     */
    public static function trialConversion(string $from, string $to): array
    {
        $ends = self::trialEnds(null, $from, $to);
        $converted = self::converted($ends, self::firstPaid(array_keys($ends)));

        return ['rate' => AnalyticsDays::rate($converted, count($ends)), 'converted' => $converted, 'ended' => count($ends)];
    }

    /**
     * @param  array<string, CarbonImmutable>  $ends
     * @param  array<string, CarbonImmutable>  $firstPaid
     */
    public static function converted(array $ends, array $firstPaid): int
    {
        $days = (int) config('analytics.trial_conversion_days', 7);
        $n = 0;
        foreach ($ends as $tenant => $end) {
            if (isset($firstPaid[$tenant]) && $firstPaid[$tenant]->lte($end->addDays($days))) {
                $n++;
            }
        }

        return $n;
    }

    /**
     * P82-15 over tenants created in [$from, $to]; "ended" / "converted" are as of the end of $asOf.
     *
     * @return array{signed_up: int, store_published: int, trial_ended: int, converted: int, trial_to_paid_rate: float|null, signup_to_paid_rate: float|null, median_days_to_paid: int|null}
     */
    public static function funnel(string $from, string $to, string $asOf): array
    {
        $db = AnalyticsData::db();
        $tenants = $db->table('tenants as t')->leftJoin('stores as s', 's.tenant_id', '=', 't.id')
            ->where('t.created_at', '>=', AnalyticsDays::startUtc($from))->where('t.created_at', '<', AnalyticsDays::endUtc($to))
            ->get(['t.id', 't.created_at', 's.published_at']);
        $ids = $tenants->pluck('id')->map(fn ($id) => (string) $id)->all();
        $cutoff = AnalyticsDays::endUtc($asOf);

        $ends = array_filter(self::trialEnds($ids), fn (CarbonImmutable $end) => $end->lt($cutoff));
        $firstPaid = array_filter(self::firstPaid($ids), fn (CarbonImmutable $paid) => $paid->lt($cutoff));

        $days = [];
        foreach ($tenants as $t) {
            if (isset($firstPaid[(string) $t->id])) {
                $days[] = (int) floor(CarbonImmutable::parse((string) $t->created_at, 'UTC')->diffInSeconds($firstPaid[(string) $t->id], false) / 86400);
            }
        }
        sort($days);
        $count = count($days);
        $median = $count === 0 ? null : ($count % 2 === 1 ? $days[intdiv($count, 2)] : (int) round(($days[$count / 2 - 1] + $days[$count / 2]) / 2));

        return [
            'signed_up' => count($ids),
            'store_published' => $tenants->whereNotNull('published_at')->count(),
            'trial_ended' => count($ends),
            'converted' => count($firstPaid),
            'trial_to_paid_rate' => AnalyticsDays::rate(self::converted($ends, $firstPaid), count($ends)),
            'signup_to_paid_rate' => AnalyticsDays::rate(count($firstPaid), count($ids)),
            'median_days_to_paid' => $median,
        ];
    }
}
