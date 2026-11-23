<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use App\Domain\Admin\Analytics\MetricsAggregator;
use App\Domain\Admin\Authorization\PlatformRole;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\AnalyticsFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/**
 * PHASE-8-2 §10 `perf` (Postgres only, CI api-perf): one aggregated day for 5 000 tenants and 200 000 orders < 30 s;
 * `GET /admin/analytics/revenue?range=12m` p95 < 500 ms uncached with 5 000 tenants × 400 days of rows. Rows are
 * generated with set-based SQL on the owner/admin connection (setup is not timed).
 */
#[Group('perf')]
#[Group('analytics')]
class AnalyticsPerfTest extends TestCase
{
    use AnalyticsFixtures, PlatformStaffFixtures, RefreshDatabase;

    private const TENANTS = 5000;

    private function requirePostgres(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            $this->markTestSkipped('Needs Postgres (CI perf job).');
        }
    }

    /** 5 000 tenants with stores and a current subscription (every 3rd paid Starter). */
    private function seedTenants(): void
    {
        $db = $this->platformTable('tenants')->getConnection();
        $starter = $this->planId('starter');
        $db->statement("insert into tenants (id, name, status, created_at, updated_at)
            select lpad(to_hex(g), 26, '0'), 'Perf '||g, 'active', timestamptz '2025-01-01 00:00Z', timestamptz '2025-01-01 00:00Z'
              from generate_series(1, ?) g", [self::TENANTS]);
        $db->statement("insert into stores (id, tenant_id, name, slug, status, country, currency, business_categories, timezone, created_at, updated_at)
            select lpad('s'||to_hex(g), 26, '0'), lpad(to_hex(g), 26, '0'), 'Perf '||g, 'perf-'||g, 'active', 'BD', 'BDT', '[]', 'Asia/Dhaka', now(), now()
              from generate_series(1, ?) g", [self::TENANTS]);
        $db->statement("insert into subscriptions (id, tenant_id, plan_id, status, billing_interval, current_period_start, current_period_end, cancel_at_period_end, notices, created_at, updated_at)
            select lpad('u'||to_hex(g), 26, '0'), lpad(to_hex(g), 26, '0'), ?, 'active', 'month', now(), now() + interval '1 month', false, '{}', now(), now()
              from generate_series(1, ?) g", [$starter, self::TENANTS]);
        $db->statement("insert into billing_invoices (id, tenant_id, subscription_id, number, kind, status, plan_id, interval, currency, subtotal_amount, tax_amount,
                total_amount, tax_rate_bps, credit_amount, lines, bill_to, issued_at, due_at, paid_at, paid_late, reminders, created_at, updated_at)
            select lpad('i'||to_hex(g), 26, '0'), lpad(to_hex(g), 26, '0'), lpad('u'||to_hex(g), 26, '0'), 'PERF-'||g, 'new', 'paid', ?, 'month', 'BDT',
                   49900, 0, 49900, 0, 0, '[]', '{}', now(), now(), now(), false, '[]', now(), now()
              from generate_series(1, ?, 3) g", [$starter, self::TENANTS]);
    }

    public function test_one_day_for_5000_tenants_and_200000_orders_under_30_seconds(): void
    {
        $this->requirePostgres();
        $this->seedTenants();
        $this->travelToDhaka('2026-11-23 00:20');
        $this->platformTable('orders')->getConnection()->statement("insert into orders (id, tenant_id, store_id, number, sequence, status, payment_status, payment_method,
                created_via, channel, customer_name, customer_phone, shipping_address, district_code, currency, subtotal_amount, total_amount,
                shipping_zone_name, tags, placed_at, created_at, updated_at)
            select lpad('o'||to_hex(g), 26, '0'), lpad(to_hex(1 + g % ?), 26, '0'), lpad('s'||to_hex(1 + g % ?), 26, '0'), 'P'||g, g,
                   case when g % 10 = 0 then 'cancelled' else 'delivered' end, 'unpaid', 'cod', 'storefront', 'website', 'Buyer', '8801700000000',
                   '{}', 'dhaka', 'BDT', 1000, 1000, 'Dhaka', '[]', timestamptz '2026-11-21 18:00Z' + (g % 86000) * interval '1 second', now(), now()
              from generate_series(1, 200000) g", [self::TENANTS, self::TENANTS]);

        $start = microtime(true);
        $summary = app(MetricsAggregator::class)->run('2026-11-22', MetricsAggregator::MODE_SNAPSHOT);
        $seconds = microtime(true) - $start;

        $this->assertSame(self::TENANTS, $summary['tenants']);
        $this->assertSame(180000, $summary['orders_count']);
        $this->assertLessThan(30.0, $seconds, sprintf('aggregate took %.1f s', $seconds));
    }

    public function test_revenue_12m_p95_under_500ms_with_5000_tenants_by_400_days(): void
    {
        $this->requirePostgres();
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->seedTenants();
        $db = $this->platformTable('tenant_daily_metrics')->getConnection();
        $db->statement("insert into tenant_daily_metrics (tenant_id, day, plan_code, billing_interval, subscription_status, tenant_status, mrr_amount, is_comp,
                orders_count, gmv_amount, currency, source, snapshot_at, computed_at)
            select lpad(to_hex(g), 26, '0'), d::date, case when g % 3 = 1 then 'starter' else 'free' end, null, null, 'active',
                   case when g % 3 = 1 and (g + extract(doy from d)::int) % 97 <> 0 then 49900 else 0 end, false, g % 4, (g % 4) * 1000, 'BDT', 'nightly', now(), now()
              from generate_series(1, ?) g, generate_series(date '2025-10-19', date '2026-11-22', interval '1 day') d", [self::TENANTS]);
        $db->statement("insert into platform_daily_metrics (day, total_tenants, active_tenants, suspended_tenants, paying_tenants, trialing_tenants, comp_tenants,
                free_tenants, past_due_tenants, new_tenants, mrr_amount, mrr_by_plan, tenants_by_plan, paying_by_plan, yearly_by_plan, orders_count, gmv_amount,
                non_bdt_orders_count, currency, source, computed_at)
            select day, count(*), count(*), 0, count(*) filter (where mrr_amount > 0), 0, 0, count(*) filter (where mrr_amount = 0), 0, 0, sum(mrr_amount),
                   jsonb_build_object('starter', sum(mrr_amount)), '{}', '{}', '{}', sum(orders_count), sum(gmv_amount), 0, 'BDT', 'nightly', now()
              from tenant_daily_metrics group by day");
        $db->statement('analyze');
        $this->travelToDhaka('2026-11-23 09:00');
        $staff = $this->staffUser(PlatformRole::SuperAdmin);
        config(['admin.ip_allowlist' => []]);

        $this->analytics($staff, 'admin/analytics/revenue?range=12m')->assertOk(); // warm-up
        $times = [];
        for ($i = 0; $i < 20; $i++) {
            Cache::flush(); // uncached
            $t = microtime(true);
            $this->analytics($staff, 'admin/analytics/revenue?range=12m')->assertOk();
            $times[] = (microtime(true) - $t) * 1000;
        }
        sort($times);
        $p95 = $times[(int) ceil(0.95 * count($times)) - 1];
        $this->assertLessThan(500.0, $p95, sprintf('revenue p95 %.0f ms', $p95));
    }
}
