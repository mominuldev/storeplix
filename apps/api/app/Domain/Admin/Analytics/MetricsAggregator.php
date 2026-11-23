<?php

declare(strict_types=1);

namespace App\Domain\Admin\Analytics;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\PlatformDb;
use Carbon\CarbonImmutable;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * Writes the nightly snapshot tables (PHASE-8-2 §4.1, P82-3 – P82-6, ADR 0016). One transaction per day on the admin
 * connection (`pgsql_admin` with RLS on), `statement_timeout` 300 s:
 *  1. tenant stocks (insert-only: existing rows keep their stock columns, P82-5),
 *  2. tenant flows (orders, GMV; restated),
 *  3. the platform row (sums/counts of that day's tenant rows),
 *  4. assertions (partition identity, MRR = Σ by plan); a failure rolls the day back.
 *
 * cross-tenant: platform analytics (B27). Query builder with bindings only.
 */
final class MetricsAggregator
{
    public const NIGHTLY = 'nightly';

    public const LATE = 'late';

    public const BACKFILL = 'backfill';

    /** Stocks of the day are captured from the current state (new tenant rows only). */
    public const MODE_SNAPSHOT = 'snapshot';

    /** Stocks of the day are overwritten from the current state (an unclosed day in local/testing only). */
    public const MODE_PROVISIONAL = 'provisional';

    /** Flows only (orders, GMV); stocks untouched. */
    public const MODE_RESTATE = 'restate';

    /** Stocks reconstructed from paid invoices and overwritten (`analytics:backfill`, `--rebuild-stocks`). */
    public const MODE_BACKFILL = 'backfill';

    private const FLOW_EXCLUDED = [Order::PENDING_PAYMENT, Order::CANCELLED];

    private const SOURCE_RANK = [self::NIGHTLY => 0, self::LATE => 1, self::BACKFILL => 2];

    public function __construct(private readonly BackfillStocks $backfill) {}

    /**
     * P82-3: every closed day of the last ANALYTICS_CATCHUP_DAYS without a platform row (ascending), then, if that
     * created yesterday's row, the flow restatement of the ANALYTICS_RESTATE_DAYS before it.
     *
     * @return array{created: list<string>, restated: list<string>}
     */
    public function catchUp(): array
    {
        $today = AnalyticsDays::today();
        $yesterday = AnalyticsDays::add($today, -1);
        $first = AnalyticsDays::add($today, -max(1, (int) config('analytics.catchup_days', 7)));
        $existing = $this->platformDays($first, $yesterday);

        $created = [];
        for ($day = $first; $day <= $yesterday; $day = AnalyticsDays::add($day, 1)) {
            if (! isset($existing[$day])) {
                $this->run($day, self::MODE_SNAPSHOT);
                $created[] = $day;
            }
        }

        $restated = [];
        if (in_array($yesterday, $created, true)) {
            $from = AnalyticsDays::add($yesterday, -max(0, (int) config('analytics.restate_days', 35)));
            $existing = $this->platformDays($from, AnalyticsDays::add($yesterday, -1));
            foreach (array_keys($existing) as $day) {
                if (! in_array($day, $created, true)) {
                    $this->run($day, self::MODE_RESTATE);
                    $restated[] = $day;
                }
            }
        }

        return ['created' => $created, 'restated' => $restated];
    }

    /**
     * §4.1 `--date` / `--from --to` / the dev endpoint: picks the mode for one explicit day.
     *  - a day after today: refused; today: refused outside local/testing, else stocks overwritten (provisional, `late`);
     *  - `--rebuild-stocks`: the backfill reconstruction overwrites the stocks;
     *  - a day with a platform row: flows restated only;
     *  - a missing day within ANALYTICS_CATCHUP_DAYS: snapshot from the current state; older: refused (use backfill).
     *
     * @return array<string, mixed> run() summary
     *
     * @throws \InvalidArgumentException when the day can't be aggregated this way
     */
    public function runDay(string $day, bool $rebuildStocks = false): array
    {
        $today = AnalyticsDays::today();
        $unclosedAllowed = app()->environment(['local', 'testing']);
        if ($day > $today || ($day === $today && ! $unclosedAllowed)) {
            throw new \InvalidArgumentException("{$day} is not a closed day yet (Dhaka today is {$today}).");
        }
        if ($day === $today) {
            return $this->run($day, self::MODE_PROVISIONAL);
        }
        if ($rebuildStocks) {
            return $this->run($day, self::MODE_BACKFILL);
        }
        if ($this->platformSource($day) !== null) {
            return $this->run($day, self::MODE_RESTATE);
        }
        if ($day >= AnalyticsDays::add($today, -max(1, (int) config('analytics.catchup_days', 7)))) {
            return $this->run($day, self::MODE_SNAPSHOT);
        }

        throw new \InvalidArgumentException("{$day} has no snapshot and is older than ".(int) config('analytics.catchup_days', 7).' days: use analytics:backfill.');
    }

    /**
     * One day. MODE_SNAPSHOT inserts missing tenant rows from the current state; MODE_RESTATE needs an existing
     * platform row and only restates flows; MODE_PROVISIONAL and MODE_BACKFILL overwrite the stocks.
     *
     * @return array{day: string, tenants: int, mrr_amount: int, gmv_amount: int, orders_count: int, source: string, ms: int}
     */
    public function run(string $day, string $mode): array
    {
        $started = microtime(true);
        $now = CarbonImmutable::now('UTC');
        $db = PlatformDb::connection(); // cross-tenant: platform analytics (B27)

        try {
            $summary = $db->transaction(function () use ($db, $day, $mode, $now): array {
                if ($db->getDriverName() === 'pgsql') {
                    $db->statement("SET LOCAL statement_timeout = '300s'");
                }
                $source = match ($mode) {
                    self::MODE_BACKFILL => self::BACKFILL,
                    self::MODE_PROVISIONAL => self::LATE,
                    default => $now->lt(AnalyticsDays::endUtc($day)->addHours(6)) ? self::NIGHTLY : self::LATE,
                };

                match ($mode) {
                    self::MODE_SNAPSHOT => $this->writeStocks($db, $day, $this->currentStocks($db, $day), $source, $now, false),
                    self::MODE_PROVISIONAL => $this->writeStocks($db, $day, $this->currentStocks($db, $day), $source, $now, true),
                    self::MODE_BACKFILL => $this->writeStocks($db, $day, $this->backfill->stocks($db, $day), $source, $now, true),
                    default => null,
                };
                $flows = $this->writeFlows($db, $day, $now);

                return $mode === self::MODE_RESTATE
                    ? $this->restatePlatformRow($db, $day, $flows, $now)
                    : $this->writePlatformRow($db, $day, $flows, $source, $now);
            });
        } catch (\Throwable $e) {
            Log::error('analytics.aggregate_failed', ['day' => $day, 'mode' => $mode, 'error' => $e->getMessage()]);

            throw $e;
        }

        $summary['ms'] = (int) round((microtime(true) - $started) * 1000);
        Log::info('analytics.aggregated', $summary + ['mode' => $mode]);

        return $summary;
    }

    /** @return array<string, true> days with a platform row in [$from, $to] */
    public function platformDays(string $from, string $to): array
    {
        return PlatformDb::connection()->table('platform_daily_metrics') // cross-tenant: platform analytics
            ->whereBetween('day', [$from, $to])->pluck('day')
            ->mapWithKeys(fn ($d) => [substr((string) $d, 0, 10) => true])->all();
    }

    public function platformSource(string $day): ?string
    {
        $source = PlatformDb::connection()->table('platform_daily_metrics')->where('day', $day)->value('source'); // cross-tenant: platform analytics

        return $source === null ? null : (string) $source;
    }

    /**
     * Stocks from the current state (P82-4, P82-7): tenants that existed at the end of the day ⟕ current subscription
     * ⟕ plan ⟕ EXISTS(paid invoice of that subscription).
     *
     * @return array<string, array<string, mixed>> tenant id → stock columns
     */
    private function currentStocks(ConnectionInterface $db, string $day): array
    {
        $rows = $db->table('tenants as t')
            ->leftJoin('subscriptions as s', function ($join): void {
                $join->on('s.tenant_id', '=', 't.id')->whereIn('s.status', Subscription::CURRENT_STATUSES);
            })
            ->leftJoin('plans as p', 'p.id', '=', 's.plan_id')
            ->where('t.created_at', '<', AnalyticsDays::endUtc($day))
            ->select(['t.id', 't.status as tenant_status', 's.id as subscription_id', 's.status as sub_status', 's.billing_interval',
                'p.code as plan_code', 'p.price_amount', 'p.price_yearly_amount'])
            ->selectRaw('(select count(*) from billing_invoices bi where bi.tenant_id = t.id and bi.subscription_id = s.id and bi.status = ?) as paid_invoices', [BillingInvoice::PAID])
            ->orderBy('t.id')
            ->get();

        $out = [];
        foreach ($rows as $r) {
            $out[(string) $r->id] = TenantStock::fromCurrent((string) $r->tenant_status, $r->subscription_id === null || $r->plan_code === null ? null : [
                'status' => (string) $r->sub_status,
                'interval' => $r->billing_interval !== null ? (string) $r->billing_interval : Plan::MONTH,
                'plan_code' => (string) $r->plan_code,
                'price_amount' => (int) $r->price_amount,
                'price_yearly_amount' => $r->price_yearly_amount !== null ? (int) $r->price_yearly_amount : null,
                'has_paid_invoice' => (int) $r->paid_invoices > 0,
            ]);
        }

        return $out;
    }

    /** @param array<string, array<string, mixed>> $stocks */
    private function writeStocks(ConnectionInterface $db, string $day, array $stocks, string $source, CarbonImmutable $now, bool $overwrite): void
    {
        if ($overwrite) {
            // Tenants no longer in the stock set (none in practice) must not keep a stale row.
            $db->table('tenant_daily_metrics')->where('day', $day)->whereNotIn('tenant_id', array_keys($stocks) ?: [''])->delete();
        }
        $rows = [];
        foreach ($stocks as $tenantId => $stock) {
            $rows[] = ['tenant_id' => $tenantId, 'day' => $day] + $stock + [
                'orders_count' => 0, 'gmv_amount' => 0, 'currency' => 'BDT', 'source' => $source,
                'snapshot_at' => $now, 'computed_at' => $now,
            ];
        }
        foreach (array_chunk($rows, 500) as $chunk) {
            $overwrite
                ? $db->table('tenant_daily_metrics')->upsert($chunk, ['tenant_id', 'day'],
                    ['plan_code', 'billing_interval', 'subscription_status', 'tenant_status', 'mrr_amount', 'is_comp', 'source', 'snapshot_at', 'computed_at'])
                : $db->table('tenant_daily_metrics')->insertOrIgnore($chunk); // ON CONFLICT DO NOTHING: stocks never overwritten
        }
    }

    /**
     * P82-11: orders placed in the day, status ∉ {pending_payment, cancelled}, BDT only (others counted separately).
     *
     * @return array{non_bdt: int}
     */
    private function writeFlows(ConnectionInterface $db, string $day, CarbonImmutable $now): array
    {
        $start = AnalyticsDays::startUtc($day);
        $end = AnalyticsDays::endUtc($day);
        [$a, $b] = self::FLOW_EXCLUDED;

        $db->table('tenant_daily_metrics')->where('day', $day)->update(['orders_count' => 0, 'gmv_amount' => 0, 'computed_at' => $now]);
        $db->update(
            'update tenant_daily_metrics set orders_count = o.n, gmv_amount = o.gmv
               from (select tenant_id, count(*) as n, sum(total_amount) as gmv from orders
                      where placed_at >= ? and placed_at < ? and status not in (?, ?) and currency = ?
                      group by tenant_id) as o
              where tenant_daily_metrics.tenant_id = o.tenant_id and tenant_daily_metrics.day = ?',
            [$start, $end, $a, $b, 'BDT', $day],
        );

        $nonBdt = (int) $db->table('orders')->where('placed_at', '>=', $start)->where('placed_at', '<', $end)
            ->whereNotIn('status', self::FLOW_EXCLUDED)->where('currency', '<>', 'BDT')->count();

        return ['non_bdt' => $nonBdt];
    }

    /**
     * Sums and counts of the day's tenant rows (+ new tenants), upserted, then the identities are asserted.
     *
     * @param  array{non_bdt: int}  $flows
     * @return array{day: string, tenants: int, mrr_amount: int, gmv_amount: int, orders_count: int, source: string}
     */
    private function writePlatformRow(ConnectionInterface $db, string $day, array $flows, string $source, CarbonImmutable $now): array
    {
        $rows = $db->table('tenant_daily_metrics')->where('day', $day)
            ->get(['plan_code', 'billing_interval', 'subscription_status', 'tenant_status', 'mrr_amount', 'is_comp', 'orders_count', 'gmv_amount', 'source']);

        $counts = [TenantStock::PAYING => 0, TenantStock::TRIALING => 0, TenantStock::COMP => 0, TenantStock::FREE => 0, TenantStock::SUSPENDED => 0];
        $active = $pastDue = $mrr = $orders = $gmv = 0;
        $mrrByPlan = $tenantsByPlan = $payingByPlan = $yearlyByPlan = [];
        $worst = $source;
        foreach ($rows as $r) {
            $category = TenantStock::category($r);
            $counts[$category]++;
            $plan = (string) ($r->plan_code ?? Plan::FREE);
            if ($r->tenant_status === Tenant::STATUS_ACTIVE) {
                $active++;
                $tenantsByPlan[$plan] = ($tenantsByPlan[$plan] ?? 0) + 1;
            }
            if ($category === TenantStock::PAYING) {
                $mrrByPlan[(string) $r->plan_code] = ($mrrByPlan[(string) $r->plan_code] ?? 0) + (int) $r->mrr_amount;
                $payingByPlan[(string) $r->plan_code] = ($payingByPlan[(string) $r->plan_code] ?? 0) + 1;
                if ($r->billing_interval === Plan::YEAR) {
                    $yearlyByPlan[(string) $r->plan_code] = ($yearlyByPlan[(string) $r->plan_code] ?? 0) + 1;
                }
                if ($r->subscription_status === Subscription::PAST_DUE) {
                    $pastDue++;
                }
            }
            $mrr += (int) $r->mrr_amount;
            $orders += (int) $r->orders_count;
            $gmv += (int) $r->gmv_amount;
            if (self::SOURCE_RANK[(string) $r->source] > self::SOURCE_RANK[$worst]) {
                $worst = (string) $r->source;
            }
        }

        // §4.1 step 4: assertions (throw → the day's transaction rolls back).
        if ($active !== $counts[TenantStock::PAYING] + $counts[TenantStock::TRIALING] + $counts[TenantStock::COMP] + $counts[TenantStock::FREE]) {
            throw new RuntimeException("analytics {$day}: partition identity failed (active {$active})");
        }
        if ($mrr !== array_sum($mrrByPlan) || isset($mrrByPlan[''])) {
            throw new RuntimeException("analytics {$day}: MRR {$mrr} != Σ by plan ".array_sum($mrrByPlan));
        }

        ksort($mrrByPlan);
        ksort($tenantsByPlan);
        ksort($payingByPlan);
        ksort($yearlyByPlan);
        $newTenants = $db->table('tenants')->where('created_at', '>=', AnalyticsDays::startUtc($day))->where('created_at', '<', AnalyticsDays::endUtc($day))->count();

        $db->table('platform_daily_metrics')->upsert([[
            'day' => $day,
            'total_tenants' => $rows->count(),
            'active_tenants' => $active,
            'suspended_tenants' => $counts[TenantStock::SUSPENDED],
            'paying_tenants' => $counts[TenantStock::PAYING],
            'trialing_tenants' => $counts[TenantStock::TRIALING],
            'comp_tenants' => $counts[TenantStock::COMP],
            'free_tenants' => $counts[TenantStock::FREE],
            'past_due_tenants' => $pastDue,
            'new_tenants' => $newTenants,
            'mrr_amount' => $mrr,
            'mrr_by_plan' => self::json($mrrByPlan),
            'tenants_by_plan' => self::json($tenantsByPlan),
            'paying_by_plan' => self::json($payingByPlan),
            'yearly_by_plan' => self::json($yearlyByPlan),
            'orders_count' => $orders,
            'gmv_amount' => $gmv,
            'non_bdt_orders_count' => $flows['non_bdt'],
            'currency' => 'BDT',
            'source' => $worst,
            'computed_at' => $now,
        ]], ['day']);

        return ['day' => $day, 'tenants' => $rows->count(), 'mrr_amount' => $mrr, 'gmv_amount' => $gmv, 'orders_count' => $orders, 'source' => $worst];
    }

    /**
     * Restatement: only the platform row's flow columns change (P82-5); stock columns stay as captured.
     *
     * @param  array{non_bdt: int}  $flows
     * @return array{day: string, tenants: int, mrr_amount: int, gmv_amount: int, orders_count: int, source: string}
     */
    private function restatePlatformRow(ConnectionInterface $db, string $day, array $flows, CarbonImmutable $now): array
    {
        $platform = $db->table('platform_daily_metrics')->where('day', $day)->first()
            ?? throw new RuntimeException("analytics {$day}: no platform row to restate");
        $sums = $db->table('tenant_daily_metrics')->where('day', $day)
            ->selectRaw('count(*) as n, coalesce(sum(orders_count), 0) as orders, coalesce(sum(gmv_amount), 0) as gmv, coalesce(sum(mrr_amount), 0) as mrr')
            ->first();
        if ((int) $sums->mrr !== (int) $platform->mrr_amount) {
            throw new RuntimeException("analytics {$day}: tenant MRR {$sums->mrr} != platform MRR {$platform->mrr_amount}");
        }
        $db->table('platform_daily_metrics')->where('day', $day)->update([
            'orders_count' => (int) $sums->orders,
            'gmv_amount' => (int) $sums->gmv,
            'non_bdt_orders_count' => $flows['non_bdt'],
            'computed_at' => $now,
        ]);

        return ['day' => $day, 'tenants' => (int) $sums->n, 'mrr_amount' => (int) $platform->mrr_amount, 'gmv_amount' => (int) $sums->gmv,
            'orders_count' => (int) $sums->orders, 'source' => (string) $platform->source];
    }

    /** @param array<string, int> $map */
    private static function json(array $map): string
    {
        return $map === [] ? '{}' : (string) json_encode($map);
    }
}
