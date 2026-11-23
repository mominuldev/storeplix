<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Support\PlatformDb;
use Database\Seeders\PlatformStaffE2eSeeder;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Symfony\Component\Finder\Finder;
use Tests\Support\AnalyticsFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-2 §6, §10 `AdminAnalyticsTest` (openapi 1.10.0 shapes; S83, S86, S87, S90). */
#[Group('analytics')]
#[Group('admin')]
class AdminAnalyticsTest extends TestCase
{
    use AnalyticsFixtures, PlatformStaffFixtures, RefreshDatabase;

    private const META = ['as_of', 'computed_at', 'data_starts_on', 'timezone', 'currency', 'range', 'granularity', 'from', 'to', 'previous_from', 'previous_to'];

    private const OVERVIEW = [
        'mrr' => ['amount', 'previous_amount', 'arr_amount'],
        'active_shops' => ['total', 'paying', 'trialing', 'comp', 'free', 'past_due', 'previous_total'],
        'trial_conversion' => ['rate', 'previous_rate', 'converted', 'ended', 'trialing_now'],
        'gmv' => ['amount', 'previous_amount', 'orders_count', 'previous_orders_count', 'aov_amount'],
        'revenue_churn' => ['rate', 'previous_rate', 'churned_amount', 'cancellations', 'opening_mrr_amount'],
        'mrr_series' => null, 'plan_mix' => null, 'plans' => null,
    ];

    private const REVENUE_KPIS = [
        'mrr' => ['amount', 'previous_amount'],
        'arr' => ['amount', 'previous_amount'],
        'net_new_mrr' => ['amount', 'previous_amount', 'new_amount', 'expansion_amount', 'contraction_amount', 'churned_amount'],
        'churned_mrr' => ['amount', 'previous_amount', 'rate', 'previous_rate', 'opening_mrr_amount', 'count'],
        'arpa' => ['amount', 'previous_amount', 'paying'],
        'ltv' => ['amount', 'lifetime_months'],
    ];

    private const TENANT_METRICS = ['mrr_amount', 'is_comp', 'plan_code', 'billing_interval', 'orders_30d', 'previous_orders_30d',
        'gmv_30d_amount', 'previous_gmv_30d_amount', 'aov_30d_amount', 'avg_orders_per_day_30d', 'gmv_month_amount', 'paid_12m_amount', 'monthly'];

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.ip_allowlist' => []]);
        $this->staff = $this->staffUser(PlatformRole::ReadOnly);
    }

    private function assertKeys(array $expected, mixed $actual, string $label): void
    {
        $this->assertIsArray($actual, $label);
        $this->assertEqualsCanonicalizing($expected, array_keys($actual), $label);
    }

    /** A small platform: two paying shops, one trial, orders over the last days, nights 2026-11-16 … 2026-11-22. */
    private function platform(): array
    {
        [$a, $b] = [$this->aTenant('Alpha', '2026-09-01 10:00'), $this->aTenant('Bravo', '2026-09-01 10:00')];
        $this->aPaidInvoice($a, $this->aSubscription($a, 'growth', 'active', createdAt: '2026-09-01 10:00'), 'growth', '2026-11-01 10:00', provider: 'sslcommerz');
        $this->aPaidInvoice($b, $this->aSubscription($b, 'starter', 'active', 'year', createdAt: '2026-09-01 10:00'), 'starter', '2026-10-01 10:00', 'year');
        $c = $this->aTenant('Charlie', '2026-11-10 10:00');
        $this->aSubscription($c, 'starter', 'trialing', trialEndsAt: '2026-11-24 10:00', createdAt: '2026-11-10 10:00');
        $this->anOrder($a, 'delivered', 120000, '2026-11-20 10:00');
        $this->anOrder($a, 'pending', 30000, '2026-11-22 10:00');
        $this->anOrder($b, 'confirmed', 50000, '2026-11-21 10:00');
        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate();

        return [$a, $b, $c];
    }

    public function test_shapes_for_every_range_match_openapi(): void
    {
        $this->platform();
        foreach (['', '?range=30d', '?range=quarter', '?range=12m', '?range=custom&from=2026-11-01&to=2026-11-22', '?range=30d&granularity=week'] as $q) {
            foreach (['overview' => self::OVERVIEW, 'revenue' => null] as $endpoint => $shape) {
                $r = $this->analytics($this->staff, "admin/analytics/{$endpoint}{$q}")->assertOk()->assertHeader('Cache-Control', 'no-store, private');
                $this->assertKeys(self::META, $r->json('meta'), "{$endpoint}{$q} meta");
                $r->assertJsonPath('meta.as_of', '2026-11-22')->assertJsonPath('meta.timezone', 'Asia/Dhaka')->assertJsonPath('meta.currency', 'BDT')
                    ->assertJsonPath('meta.data_starts_on', '2026-11-16');
                if ($endpoint === 'overview') {
                    $this->assertKeys(array_keys($shape), $r->json('data'), $q);
                    foreach ($shape as $key => $fields) {
                        if ($fields !== null) {
                            $this->assertKeys($fields, $r->json("data.{$key}"), "overview {$key}");
                        }
                    }
                    foreach ($r->json('data.mrr_series') as $point) {
                        $this->assertKeys(['bucket_start', 'bucket_end', 'mrr_amount', 'by_plan'], $point, 'mrr point');
                    }
                } else {
                    $this->assertKeys(['kpis', 'movement', 'cohorts', 'by_plan', 'trial_funnel', 'top_merchants'], $r->json('data'), $q);
                    foreach (self::REVENUE_KPIS as $key => $fields) {
                        $this->assertKeys($fields, $r->json("data.kpis.{$key}"), "kpi {$key}");
                    }
                    foreach ($r->json('data.movement') as $bucket) {
                        $this->assertKeys(['bucket_start', 'bucket_end', 'opening_mrr_amount', 'new_amount', 'expansion_amount', 'contraction_amount',
                            'churned_amount', 'net_new_amount', 'closing_mrr_amount', 'counts'], $bucket, 'movement');
                    }
                    $this->assertKeys(['rows', 'm3_average'], $r->json('data.cohorts'), 'cohorts');
                    $this->assertKeys(['shops', 'paying', 'mrr_amount', 'previous_mrr_amount'], $r->json('data.by_plan.total'), 'by_plan total');
                    foreach ($r->json('data.by_plan.rows') as $row) {
                        $this->assertKeys(['plan_code', 'plan_name', 'monthly_price_amount', 'shops', 'mrr_amount', 'previous_mrr_amount', 'share', 'yearly_share'], $row, 'by_plan row');
                    }
                    $this->assertKeys(['signed_up', 'store_published', 'trial_ended', 'converted', 'trial_to_paid_rate', 'signup_to_paid_rate', 'median_days_to_paid'],
                        $r->json('data.trial_funnel'), 'funnel');
                }
            }
        }

        $rev = $this->analytics($this->staff, 'admin/analytics/revenue')->assertJsonPath('meta.range', '12m')->assertJsonPath('meta.granularity', 'month');
        $this->analytics($this->staff, 'admin/analytics/overview')->assertJsonPath('meta.range', '30d')->assertJsonPath('meta.from', '2026-10-24');
        $top = $rev->json('data.top_merchants');
        $this->assertSame(['Alpha Store', 'Bravo Store'], array_column(array_column($top, 'tenant'), 'name'));
        $this->assertKeys(['tenant', 'primary_host', 'plan_code', 'billing_interval', 'last_payment_provider', 'orders_30d', 'mrr_amount', 'customer_since', 'lifetime_paid_amount'], $top[0], 'top');
        $this->assertSame(['growth', 'month', 'sslcommerz', 2, 149900, '2026-11-01', 149900], [$top[0]['plan_code'], $top[0]['billing_interval'],
            $top[0]['last_payment_provider'], $top[0]['orders_30d'], $top[0]['mrr_amount'], $top[0]['customer_since'], $top[0]['lifetime_paid_amount']]);
        $this->assertSame(41583, $top[1]['mrr_amount']);
        $this->assertNull($top[0]['primary_host']); // fixture shops have no domain rows
        $this->assertCount(12, $rev->json('data.movement'));
    }

    public function test_custom_range_and_granularity_validation(): void
    {
        $this->platform();
        foreach ([
            '?range=weekly', '?granularity=hour', '?range=custom', '?range=custom&from=2026-11-01', '?range=custom&from=2026-11-10&to=2026-11-01',
            '?range=custom&from=2023-12-31&to=2024-03-01', '?range=custom&from=2024-11-20&to=2026-11-21', // 732 days
            '?range=custom&from=not-a-date&to=2026-11-01', '?range=12m&granularity=day', '?range=quarter&granularity=day&from=x',
            "?range=custom&from=2026-11-01'--&to=2026-11-02",
        ] as $q) {
            foreach (['overview', 'revenue'] as $endpoint) {
                $this->analytics($this->staff, "admin/analytics/{$endpoint}{$q}")->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
            }
        }
        $this->analytics($this->staff, 'admin/analytics/overview?range=custom&from=2024-11-22&to=2026-11-22')->assertOk() // 731 days
            ->assertJsonPath('meta.granularity', 'month');
        $this->analytics($this->staff, 'admin/analytics/overview?range=custom&from=2026-11-01&to=2027-01-31')->assertOk()
            ->assertJsonPath('meta.to', '2026-11-22'); // clamped to as_of
        $this->analytics($this->staff, 'admin/analytics/overview?range=quarter&granularity=day')->assertOk()->assertJsonCount(90, 'data.mrr_series');
    }

    public function test_no_data_yet_answers_200_with_nulls(): void
    {
        $this->travelToDhaka('2026-11-23 09:00');
        $this->analytics($this->staff, 'admin/analytics/overview')->assertOk()
            ->assertJsonPath('meta.as_of', null)->assertJsonPath('meta.computed_at', null)->assertJsonPath('meta.data_starts_on', null)
            ->assertJsonPath('meta.to', '2026-11-22')->assertJsonPath('meta.from', '2026-10-24')
            ->assertJsonPath('data.mrr', ['amount' => null, 'previous_amount' => null, 'arr_amount' => null])
            ->assertJsonPath('data.active_shops.total', null)->assertJsonPath('data.gmv.amount', null)->assertJsonPath('data.plan_mix', [])
            ->assertJsonPath('data.revenue_churn.rate', null)->assertJsonPath('data.trial_conversion.rate', null)
            ->assertJsonPath('data.mrr_series.0.mrr_amount', null);
        $this->analytics($this->staff, 'admin/analytics/revenue')->assertOk()
            ->assertJsonPath('data.kpis.mrr.amount', null)->assertJsonPath('data.cohorts', ['rows' => [], 'm3_average' => null])
            ->assertJsonPath('data.top_merchants', [])->assertJsonPath('data.by_plan.total.mrr_amount', null)
            ->assertJsonPath('data.movement.0.counts', null);
    }

    public function test_the_cache_key_changes_after_a_run(): void
    {
        [$a] = $this->platform();
        $this->analytics($this->staff, 'admin/analytics/overview')->assertJsonPath('data.gmv.amount', 200000);
        $this->anOrder($a, 'delivered', 1000, '2026-11-22 12:00');
        $this->analytics($this->staff, 'admin/analytics/overview')->assertJsonPath('data.gmv.amount', 200000); // cached
        $this->travelToDhaka('2026-11-23 00:25');
        $this->aggregate(['--date' => '2026-11-22']);
        $this->analytics($this->staff, 'admin/analytics/overview')->assertJsonPath('data.gmv.amount', 201000);
    }

    public function test_merchants_list_metric_fields_and_sorts(): void
    {
        [$a, $b, $c] = $this->platform();
        $today = $this->aTenant('Delta', '2026-11-23 00:10'); // created after the night: no row on as_of
        $this->platformTable('tenants')->where('id', $b)->update(['last_active_at' => now()->subHour()]);
        $this->platformTable('tenants')->where('id', $c)->update(['last_active_at' => now()->subDay()]);

        $list = $this->analytics($this->staff, 'admin/tenants?sort=-mrr')->assertOk()->assertJsonPath('meta.metrics_as_of', '2026-11-22')
            ->assertJsonPath('meta.counts.all', 4);
        $this->assertSame([$a, $b, $c, $today], array_column($list->json('data'), 'id'));
        $list->assertJsonPath('data.0.metrics', ['as_of' => '2026-11-22', 'mrr_amount' => 149900, 'is_comp' => false, 'orders_30d' => 2, 'gmv_30d_amount' => 150000])
            ->assertJsonPath('data.3.metrics', null)->assertJsonPath('data.3.last_active_at', null)
            ->assertJsonPath('data.1.last_active_at', now()->subHour()->utc()->toIso8601ZuluString());

        $ids = fn (string $sort) => array_column($this->analytics($this->staff, "admin/tenants?sort={$sort}")->assertOk()->json('data'), 'id');
        $this->assertSame([$c, $b, $a, $today], $ids('mrr')); // 0, 41 583, 149 900, null last
        $this->assertSame([$a, $b, $c, $today], $ids('-gmv_30d'));
        $this->assertSame([$a, $b, $c, $today], $ids('-orders_30d'));
        $this->assertSame([$b, $c], array_slice($ids('-last_active_at'), 0, 2));
        $this->assertSame([$c, $b], array_slice($ids('last_active_at'), 0, 2));
        $this->assertContains($ids('-last_active_at')[3], [$a, $today]);
        $this->analytics($this->staff, 'admin/tenants?sort=-mrr&filter[status]=trial')->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $c);
        $this->analytics($this->staff, 'admin/tenants?sort=-health')->assertStatus(422);

        // the other summary producers carry the fields too
        $this->analytics($this->staff, 'admin/overview')->assertOk()->assertJsonPath('data.newest_tenants.0.metrics', null)
            ->assertJsonPath('data.newest_tenants.1.metrics.mrr_amount', 0);
        $this->analytics($this->staff, "admin/tenants/{$a}")->assertOk()->assertJsonPath('data.metrics.mrr_amount', 149900);
    }

    public function test_tenant_metrics_detail_and_unknown_tenant(): void
    {
        [$a, , $c] = $this->platform();
        $support = $this->staffUser(PlatformRole::Support); // per-shop numbers: view_merchants (Q108)
        $r = $this->analytics($support, "admin/tenants/{$a}/metrics")->assertOk()
            ->assertJsonPath('meta.range', '30d')->assertJsonPath('meta.from', '2026-10-24')->assertJsonPath('meta.to', '2026-11-22')
            ->assertJsonPath('meta.previous_from', '2026-09-24')->assertJsonPath('meta.previous_to', '2026-10-23');
        $this->assertKeys(self::TENANT_METRICS, $r->json('data'), 'tenant metrics');
        $this->assertSame([149900, false, 'growth', 'month', 2, null, 150000, null, 75000, 0.1, 150000, 149900], [
            $r->json('data.mrr_amount'), $r->json('data.is_comp'), $r->json('data.plan_code'), $r->json('data.billing_interval'),
            $r->json('data.orders_30d'), $r->json('data.previous_orders_30d'), $r->json('data.gmv_30d_amount'), $r->json('data.previous_gmv_30d_amount'),
            $r->json('data.aov_30d_amount'), $r->json('data.avg_orders_per_day_30d'), $r->json('data.gmv_month_amount'), $r->json('data.paid_12m_amount'),
        ]);
        $monthly = $r->json('data.monthly');
        $this->assertCount(12, $monthly);
        $this->assertSame(['month' => '2025-12', 'gmv_amount' => null, 'orders_count' => null], $monthly[0]);
        $this->assertSame(['month' => '2026-11', 'gmv_amount' => 150000, 'orders_count' => 2], $monthly[11]);
        $this->analytics($support, "admin/tenants/{$c}/metrics")->assertOk()->assertJsonPath('data.mrr_amount', 0)->assertJsonPath('data.plan_code', 'starter');

        foreach ([strtolower((string) Str::ulid()), 'not-a-ulid'] as $id) {
            $this->analytics($support, "admin/tenants/{$id}/metrics")->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
        $this->analytics($support, 'admin/analytics/revenue')->assertForbidden()->assertJsonPath('error.code', 'forbidden'); // S83
    }

    /** P82-20 / S85: every analytics read runs on the platform connection (pgsql_admin with RLS on). */
    public function test_analytics_queries_run_on_the_admin_connection(): void
    {
        [$a] = $this->platform();
        $expected = PlatformDb::connectionName() ?? DB::getDefaultConnection();
        $seen = [];
        Event::listen(QueryExecuted::class, function (QueryExecuted $q) use (&$seen): void {
            if (str_contains($q->sql, 'daily_metrics')) {
                $seen[] = $q->connectionName;
            }
        });
        $this->analytics($this->staff, 'admin/analytics/overview')->assertOk();
        $this->analytics($this->staff, 'admin/analytics/revenue')->assertOk();
        $this->analytics($this->staff, "admin/tenants/{$a}/metrics")->assertOk();
        $this->analytics($this->staff, 'admin/tenants?sort=-gmv_30d')->assertOk();

        $this->assertNotEmpty($seen);
        $this->assertSame([$expected], array_values(array_unique($seen)));
    }

    /** §4.3 testing-only dev endpoint (S90). */
    public function test_dev_aggregate_endpoint_is_super_admin_only_and_never_registered_in_production(): void
    {
        $this->travelToDhaka('2026-11-23 15:00');
        $t = $this->aTenant('Fresh', '2026-11-23 10:00');
        $this->anOrder($t, 'pending', 25000, '2026-11-23 14:00');
        $post = fn (User $u, array $body = []) => $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($u))
            ->postJson('/api/v1/dev/analytics/aggregate', $body);

        $post($this->staff)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $sa = $this->staffUser(PlatformRole::SuperAdmin);
        $post($sa)->assertOk()->assertExactJson(['data' => ['days' => ['2026-11-23'], 'as_of' => '2026-11-23']]);
        $this->assertSame(25000, (int) $this->tenantRow($t, '2026-11-23')->gmv_amount);
        $post($sa, ['from' => '2026-11-21', 'to' => '2026-11-22'])->assertOk()->assertJsonPath('data.days', ['2026-11-21', '2026-11-22']);
        $post($sa, ['from' => '2026-11-01', 'to' => '2026-11-02'])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed'); // > 7 days: backfill
        $post($sa, ['from' => '2026-11-24'])->assertStatus(422);
        $this->flushHeaders()->postJson('/api/v1/dev/analytics/aggregate')->assertUnauthorized();
        [$merchant] = $this->merchant();
        $this->flushHeaders()->withHeaders($this->tenantHeaders($merchant, strtolower((string) Str::ulid())))->postJson('/api/v1/dev/analytics/aggregate')->assertForbidden();

        // production: the routes file registers no /dev/analytics route
        $this->app['env'] = 'production';
        $router = new Router($this->app['events'], $this->app);
        $this->app->instance('router', $router);
        Route::clearResolvedInstance('router');
        $router->prefix('api/v1')->group(base_path('routes/admin-analytics.php'));
        $uris = collect($router->getRoutes()->getRoutes())->map(fn ($r) => $r->uri())->all();
        $this->assertContains('api/v1/admin/analytics/overview', $uris);
        $this->assertNotContains('api/v1/dev/analytics/aggregate', $uris);
    }

    /** e2e hook: the staff seeder also provides a Support user (no view_analytics) for phase8-2.dashboard. */
    public function test_the_e2e_staff_seeder_adds_a_support_user(): void
    {
        $this->seed(PlatformStaffE2eSeeder::class);
        $this->seed(PlatformStaffE2eSeeder::class); // idempotent
        $this->assertSame('support', User::query()->where('email', PlatformStaffE2eSeeder::SUPPORT_EMAIL)->sole()->platform_role);
        $this->assertSame('super_admin', User::query()->where('email', PlatformStaffE2eSeeder::EMAIL)->sole()->platform_role);
    }

    /** S87: no merchant or storefront resource exposes platform metrics or last_active_at. */
    public function test_no_merchant_or_storefront_resource_contains_metric_keys(): void
    {
        $offenders = [];
        $finder = (new Finder)->files()->name('*.php')->in(base_path('app/Domain'))->exclude(['Admin']);
        foreach ($finder as $file) {
            if (! preg_match('#/(Http|Resources)/#', $file->getRealPath())) {
                continue;
            }
            if (preg_match("/'(mrr_amount|mrr|gmv_30d_amount|gmv_30d|orders_30d|last_active_at)'/", $file->getContents()) === 1) {
                $offenders[] = $file->getRelativePathname();
            }
        }
        $this->assertSame([], $offenders);
    }
}
