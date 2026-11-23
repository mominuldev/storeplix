<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use App\Domain\Admin\Analytics\AnalyticsData;
use App\Domain\Admin\Analytics\AnalyticsWindow;
use App\Domain\Admin\Analytics\TenantStock;
use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\AnalyticsFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/**
 * PHASE-8-2 §3 / §10 `AnalyticsDefinitionsTest`: every metric definition against a hand-computed fixture, to the paisa,
 * through the real night job and the real endpoints (sqlite and Postgres, RLS on in `api-rls`).
 */
#[Group('analytics')]
#[Group('admin')]
class AnalyticsDefinitionsTest extends TestCase
{
    use AnalyticsFixtures, PlatformStaffFixtures, RefreshDatabase;

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.ip_allowlist' => []]);
        $this->staff = $this->staffUser(PlatformRole::ReadOnly);
    }

    /**
     * The §10 table: A–K, opening day 2026-10-31, as_of 2026-11-22, range custom 2026-11-01 … 2026-11-22 (month).
     *
     * @return array<string, string> tenant ids
     */
    private function mrrFixture(): array
    {
        $t = [];
        $sub = [];
        foreach (['A' => 'starter', 'B' => 'starter', 'E' => 'starter', 'F' => 'growth', 'G' => 'starter', 'I' => 'growth'] as $name => $plan) {
            $t[$name] = $this->aTenant("Shop {$name}", '2026-09-01 10:00');
            $sub[$name] = $this->aSubscription($t[$name], $plan, 'active', createdAt: '2026-09-01 10:00');
            $this->aPaidInvoice($t[$name], $sub[$name], $plan, '2026-10-15 10:00', periodStart: '2026-10-15 10:00');
        }
        $t['K'] = $this->aTenant('Shop K', '2026-09-01 10:00');
        $sub['K'] = $this->aSubscription($t['K'], 'free', 'active', createdAt: '2026-09-01 10:00');

        $this->travelToDhaka('2026-11-01 00:20');
        $this->aggregate();

        // Changes during November.
        $this->updateSubscription($sub['B'], ['plan' => 'growth', 'billing_interval' => 'year']);
        $this->aPaidInvoice($t['B'], $sub['B'], 'growth', '2026-11-10 10:00', 'year');
        $this->updateSubscription($sub['E'], ['status' => 'past_due']);
        $this->platformTable('tenants')->where('id', $t['F'])->update(['status' => 'suspended', 'suspended_at' => now()]);
        $this->updateSubscription($sub['G'], ['status' => 'expired']);
        $t['H'] = $this->aTenant('Shop H', '2026-11-05 10:00');
        $subH = $this->aSubscription($t['H'], 'growth', 'active', createdAt: '2026-11-05 10:00');
        $this->aPaidInvoice($t['H'], $subH, 'growth', '2026-11-05 11:00');
        $this->updateSubscription($sub['I'], ['plan' => 'starter']);
        $t['J'] = $this->aTenant('Shop J', '2026-11-10 10:00');
        $this->aSubscription($t['J'], 'starter', 'trialing', trialEndsAt: '2026-11-24 10:00', createdAt: '2026-11-10 10:00');
        $this->updateSubscription($sub['K'], ['plan' => 'growth']); // "Change plan → Now": no paid invoice on the row = comp

        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate();

        return $t;
    }

    public function test_mrr_movement_churn_partition_and_plan_mix_match_the_hand_computed_fixture(): void
    {
        $t = $this->mrrFixture();

        // Per-tenant stocks (P82-7).
        $expect = ['A' => 49900, 'B' => 124916, 'E' => 49900, 'F' => 0, 'G' => 0, 'H' => 149900, 'I' => 49900, 'J' => 0, 'K' => 0];
        foreach ($expect as $name => $mrr) {
            $this->assertSame($mrr, (int) $this->tenantRow($t[$name], '2026-11-22')->mrr_amount, "tenant {$name}");
        }
        $this->assertTrue((bool) $this->tenantRow($t['K'], '2026-11-22')->is_comp);
        $this->assertSame('past_due', $this->tenantRow($t['E'], '2026-11-22')->subscription_status);
        $this->assertSame('suspended', $this->tenantRow($t['F'], '2026-11-22')->tenant_status);
        $this->assertSame('free', $this->tenantRow($t['G'], '2026-11-22')->plan_code);
        $this->assertNull($this->tenantRow($t['H'], '2026-10-31'));

        $p = $this->platformRow('2026-11-22');
        $this->assertSame([9, 8, 1, 5, 1, 1, 1, 1], array_map('intval', [$p->total_tenants, $p->active_tenants, $p->suspended_tenants,
            $p->paying_tenants, $p->trialing_tenants, $p->comp_tenants, $p->free_tenants, $p->past_due_tenants]));
        $this->assertSame(424516, (int) $p->mrr_amount);
        $this->assertSame(499400, (int) $this->platformRow('2026-10-31')->mrr_amount);

        $q = 'range=custom&from=2026-11-01&to=2026-11-22&granularity=month';
        $revenue = $this->analytics($this->staff, 'admin/analytics/revenue?'.$q)->assertOk()
            ->assertJsonPath('meta.as_of', '2026-11-22')->assertJsonPath('meta.from', '2026-11-01')->assertJsonPath('meta.to', '2026-11-22')
            ->assertJsonPath('meta.previous_from', '2026-10-10')->assertJsonPath('meta.previous_to', '2026-10-31')
            ->assertJsonPath('data.kpis.mrr.amount', 424516)
            ->assertJsonPath('data.kpis.arr.amount', 5094192)
            ->assertJsonPath('data.kpis.arpa.amount', 84903)->assertJsonPath('data.kpis.arpa.paying', 5)
            ->assertJsonPath('data.kpis.net_new_mrr.amount', -74884)
            ->assertJsonPath('data.kpis.net_new_mrr.new_amount', 149900)
            ->assertJsonPath('data.kpis.net_new_mrr.expansion_amount', 75016)
            ->assertJsonPath('data.kpis.net_new_mrr.contraction_amount', 100000)
            ->assertJsonPath('data.kpis.net_new_mrr.churned_amount', 199800)
            ->assertJsonPath('data.kpis.churned_mrr.rate', 0.4001)
            ->assertJsonPath('data.kpis.churned_mrr.count', 2)
            ->assertJsonPath('data.kpis.churned_mrr.opening_mrr_amount', 499400)
            ->assertJsonPath('data.movement.0.opening_mrr_amount', 499400)
            ->assertJsonPath('data.movement.0.closing_mrr_amount', 424516)
            ->assertJsonPath('data.movement.0.net_new_amount', -74884)
            ->assertJsonPath('data.movement.0.counts', ['new' => 1, 'expansion' => 1, 'contraction' => 1, 'churned' => 2]);
        $this->assertCount(1, $revenue->json('data.movement'));

        // by plan (plans order desc: Growth, Starter, Free)
        $rows = collect($revenue->json('data.by_plan.rows'))->keyBy('plan_code');
        $this->assertSame(['growth', 'starter', 'free'], $rows->keys()->all());
        $this->assertSame(274816, $rows['growth']['mrr_amount']); // B 124 916 + H 149 900
        $this->assertSame(2, $rows['growth']['shops']);
        $this->assertSame(0.5, $rows['growth']['yearly_share']);
        $this->assertSame(149700, $rows['starter']['mrr_amount']); // A + E + I
        $this->assertSame(1, $rows['free']['shops']);
        $this->assertSame(['shops' => 6, 'paying' => 5, 'mrr_amount' => 424516, 'previous_mrr_amount' => 499400], $revenue->json('data.by_plan.total'));

        // Logo churn 2 / 6 (P82-10).
        $windows = [['2026-11-01', '2026-11-22']];
        $mv = AnalyticsData::movement('2026-11-01', '2026-11-22', AnalyticsData::tenantMrr(AnalyticsData::movementDays($windows)),
            AnalyticsData::platformRows(AnalyticsData::movementDays($windows)));
        $this->assertSame(0.3333, round($mv['counts']['churned'] / $mv['opening_paying'], 4));

        $overview = $this->analytics($this->staff, 'admin/analytics/overview?'.$q)->assertOk()
            ->assertJsonPath('data.mrr', ['amount' => 424516, 'previous_amount' => 499400, 'arr_amount' => 5094192])
            ->assertJsonPath('data.active_shops', ['total' => 8, 'paying' => 5, 'trialing' => 1, 'comp' => 1, 'free' => 1, 'past_due' => 1, 'previous_total' => 7])
            ->assertJsonPath('data.revenue_churn.rate', 0.4001)->assertJsonPath('data.revenue_churn.cancellations', 2)
            ->assertJsonPath('data.mrr_series.0.mrr_amount', 424516)
            ->assertJsonPath('data.mrr_series.0.by_plan', ['growth' => 274816, 'starter' => 149700]);
        $this->assertSame(['free' => 1, 'starter' => 4, 'growth' => 3],
            collect($overview->json('data.plan_mix'))->pluck('count', 'plan_code')->all());
        $this->assertSame(['free', 'starter', 'growth'], array_column($overview->json('data.plans'), 'code'));
    }

    public function test_gmv_orders_aov_on_dhaka_days_and_restatement_for_35_days_only(): void
    {
        $a = $this->aTenant('Shop A', '2026-09-01 10:00');
        $this->anOrder($a, 'delivered', 100000, '2026-11-20T18:30:00Z'); // 2026-11-21 00:30 Dhaka ✓
        $pending = $this->anOrder($a, 'pending', 50000, '2026-11-21T17:59:00Z'); // 23:59 Dhaka ✓
        $this->anOrder($a, 'delivered', 70000, '2026-11-21T18:00:00Z'); // → 2026-11-22
        $this->anOrder($a, 'cancelled', 30000, '2026-11-21 12:00'); // ✗
        $this->anOrder($a, 'pending_payment', 20000, '2026-11-21 12:00'); // ✗
        $this->anOrder($a, 'returned', 40000, '2026-11-21 13:00'); // ✓ (sold)
        $this->anOrder($a, 'delivered', 99000, '2026-11-21 14:00', 'USD'); // non-BDT: counted apart
        $old = $this->anOrder($a, 'pending', 10000, '2026-10-18 12:00');
        $edge = $this->anOrder($a, 'pending', 5000, '2026-10-19 12:00');

        $this->travelToDhaka('2026-11-22 00:20');
        $this->artisan('analytics:backfill', ['--from' => '2026-10-18', '--to' => '2026-10-19'])->assertExitCode(0);
        $this->aggregate();

        $row = $this->tenantRow($a, '2026-11-21');
        $this->assertSame([190000, 3], [(int) $row->gmv_amount, (int) $row->orders_count]);
        $this->assertSame(1, (int) $this->platformRow('2026-11-21')->non_bdt_orders_count);
        $this->analytics($this->staffUser(PlatformRole::Billing), 'admin/analytics/overview?range=custom&from=2026-11-21&to=2026-11-21')->assertOk()
            ->assertJsonPath('data.gmv.amount', 190000)->assertJsonPath('data.gmv.orders_count', 3)->assertJsonPath('data.gmv.aov_amount', 63333);

        foreach ([$pending, $old, $edge] as $order) {
            $this->platformTable('orders')->where('id', $order)->update(['status' => 'cancelled']);
        }
        $this->travelToDhaka('2026-11-24 00:20'); // creates 2026-11-22 and 2026-11-23, restates 2026-10-19 … 2026-11-22
        $this->aggregate();

        $row = $this->tenantRow($a, '2026-11-21');
        $this->assertSame([140000, 2], [(int) $row->gmv_amount, (int) $row->orders_count]);
        $this->assertSame(140000, (int) $this->platformRow('2026-11-21')->gmv_amount);
        $this->assertSame(70000, (int) $this->tenantRow($a, '2026-11-22')->gmv_amount);
        $this->assertSame(0, (int) $this->tenantRow($a, '2026-10-19')->gmv_amount); // 35th day before: restated
        $this->assertSame(10000, (int) $this->tenantRow($a, '2026-10-18')->gmv_amount); // 36th: frozen
    }

    public function test_trial_to_paid_and_the_trial_funnel(): void
    {
        $mk = function (string $name, string $created, string $trialEnd, ?string $paid, bool $published) {
            $id = $this->aTenant($name, $created, publishedAt: $published ? $created : null);
            $sub = $this->aSubscription($id, 'starter', $paid === null ? 'expired' : 'active', trialEndsAt: $trialEnd, createdAt: $created);
            if ($paid !== null) {
                $this->aPaidInvoice($id, $sub, 'starter', $paid);
            }

            return $id;
        };
        $mk('T1', '2026-10-22 10:00', '2026-11-05 10:00', '2026-11-11 10:00', true); // +6 d: converted
        $mk('T2', '2026-10-23 10:00', '2026-11-06 10:00', '2026-11-14 10:00', false); // +8 d: not converted
        $mk('T3', '2026-10-24 10:00', '2026-11-07 10:00', '2026-11-03 10:00', true); // paid during the trial: converted
        $mk('T4', '2026-10-25 10:00', '2026-11-08 10:00', null, false); // never
        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate();

        $this->analytics($this->staff, 'admin/analytics/overview?range=custom&from=2026-11-01&to=2026-11-22')->assertOk()
            ->assertJsonPath('data.trial_conversion.ended', 4)->assertJsonPath('data.trial_conversion.converted', 2)
            ->assertJsonPath('data.trial_conversion.rate', 0.5)->assertJsonPath('data.trial_conversion.previous_rate', null);

        $this->analytics($this->staff, 'admin/analytics/revenue?range=custom&from=2026-10-20&to=2026-11-22')->assertOk()
            ->assertJsonPath('data.trial_funnel', [
                'signed_up' => 4, 'store_published' => 2, 'trial_ended' => 4, 'converted' => 3,
                'trial_to_paid_rate' => 0.5, 'signup_to_paid_rate' => 0.75, 'median_days_to_paid' => 20,
            ]);
    }

    /** Writes a synthetic night: platform row + tenant rows (tenant id → MRR). */
    private function night(string $day, array $mrr): void
    {
        foreach ($mrr as $tenant => $amount) {
            $this->platformTable('tenant_daily_metrics')->insert(['tenant_id' => $tenant, 'day' => $day, 'plan_code' => 'starter',
                'billing_interval' => 'month', 'subscription_status' => 'active', 'tenant_status' => 'active', 'mrr_amount' => $amount,
                'is_comp' => false, 'orders_count' => 0, 'gmv_amount' => 0, 'currency' => 'BDT', 'source' => 'nightly', 'snapshot_at' => now(), 'computed_at' => now()]);
        }
        $n = count($mrr);
        $this->platformTable('platform_daily_metrics')->insert(['day' => $day, 'total_tenants' => $n, 'active_tenants' => $n,
            'suspended_tenants' => 0, 'paying_tenants' => $n, 'trialing_tenants' => 0, 'comp_tenants' => 0, 'free_tenants' => 0,
            'past_due_tenants' => 0, 'new_tenants' => 0, 'mrr_amount' => array_sum($mrr), 'mrr_by_plan' => json_encode(['starter' => array_sum($mrr)]),
            'tenants_by_plan' => json_encode(['starter' => $n]), 'paying_by_plan' => json_encode(['starter' => $n]), 'yearly_by_plan' => '{}',
            'orders_count' => 0, 'gmv_amount' => 0, 'non_bdt_orders_count' => 0, 'currency' => 'BDT', 'source' => 'nightly', 'computed_at' => now()]);
    }

    public function test_cohort_retention_by_first_paid_month_with_nulls_before_the_data_and_weighted_m3(): void
    {
        $c = [];
        foreach (['C5' => '2026-07-05', 'C0' => '2026-08-15', 'C0b' => '2026-08-20', 'C1' => '2026-09-10', 'C2' => '2026-09-12', 'C3' => '2026-10-03'] as $name => $paid) {
            $c[$name] = $this->aTenant($name, '2026-06-01 10:00');
            $this->aPaidInvoice($c[$name], $this->aSubscription($c[$name], 'starter', 'active', createdAt: '2026-06-01 10:00'), 'starter', "{$paid} 10:00");
        }
        $this->night('2026-09-30', [$c['C0'] => 49900, $c['C0b'] => 49900, $c['C1'] => 49900, $c['C2'] => 49900]);
        $this->night('2026-10-31', [$c['C5'] => 49900, $c['C0'] => 49900, $c['C0b'] => 49900, $c['C1'] => 49900, $c['C2'] => 49900, $c['C3'] => 49900]);
        $this->night('2026-11-22', [$c['C1'] => 49900, $c['C3'] => 49900]);
        $this->travelToDhaka('2026-11-23 09:00');

        $cohorts = $this->analytics($this->staff, 'admin/analytics/revenue')->assertOk()->assertJsonPath('meta.data_starts_on', '2026-09-30')
            ->json('data.cohorts');
        $rows = collect($cohorts['rows'])->keyBy('cohort');
        $this->assertCount(12, $cohorts['rows']);
        $this->assertSame('2025-12', $cohorts['rows'][0]['cohort']);
        $this->assertSame(['size' => 1, 'retention' => [null, null, 0, 1, 0]], array_intersect_key($rows['2026-07'], ['size' => 1, 'retention' => 1]));
        $this->assertSame([null, 1, 1, 0], $rows['2026-08']['retention']);
        $this->assertSame([1, 1, 0.5], $rows['2026-09']['retention']);
        $this->assertSame([1, 1], $rows['2026-10']['retention']);
        $this->assertSame(['cohort' => '2026-11', 'size' => 0, 'retention' => [null]], $rows['2026-11']);
        $this->assertSame(0.3333, $cohorts['m3_average']); // (1 × 1 + 2 × 0.0) / 3
    }

    public function test_ltv_from_the_mean_churn_of_the_last_three_complete_months(): void
    {
        $ids = [];
        foreach (['P', 'c1', 'c2', 'c3'] as $name) {
            $ids[$name] = $this->aTenant($name, '2026-01-01 10:00');
        }
        $this->night('2026-07-31', [$ids['P'] => 98000, $ids['c1'] => 2000]);
        $this->night('2026-08-31', [$ids['P'] => 97000, $ids['c2'] => 3000]); // Aug churn 2 000 / 100 000
        $this->night('2026-09-30', [$ids['P'] => 96000, $ids['c3'] => 4000]); // Sep churn 3 000 / 100 000
        $this->night('2026-10-31', [$ids['P'] => 96000]); // Oct churn 4 000 / 100 000
        $this->night('2026-11-22', [$ids['P'] => 96000]);
        $this->travelToDhaka('2026-11-23 09:00');

        $ltv = fn () => $this->analytics($this->staff, 'admin/analytics/revenue')->assertOk()->json('data.kpis.ltv');
        $this->assertSame(['amount' => 3196800, 'lifetime_months' => 33.3], $ltv()); // 96 000 × 33.3

        // mean 0 → null
        $this->platformTable('tenant_daily_metrics')->where('day', '2026-09-30')->where('tenant_id', $ids['c3'])->delete();
        $this->platformTable('tenant_daily_metrics')->where('day', '2026-08-31')->where('tenant_id', $ids['c2'])->delete();
        $this->platformTable('tenant_daily_metrics')->where('day', '2026-07-31')->where('tenant_id', $ids['c1'])->delete();
        Cache::flush();
        $this->assertSame(['amount' => null, 'lifetime_months' => null], $ltv());

        // tiny churn → capped at 60 months
        $this->platformTable('tenant_daily_metrics')->insert(['tenant_id' => $ids['c1'], 'day' => '2026-07-31', 'plan_code' => 'starter',
            'tenant_status' => 'active', 'mrr_amount' => 1, 'is_comp' => false, 'source' => 'nightly']);
        Cache::flush();
        $this->assertSame(['amount' => 5760000, 'lifetime_months' => 60], $ltv());

        // one month without data → null
        $this->platformTable('platform_daily_metrics')->where('day', '2026-07-31')->delete();
        Cache::flush();
        $this->assertSame(['amount' => null, 'lifetime_months' => null], $ltv());
    }

    public function test_yearly_floors_comp_and_suspended_stocks(): void
    {
        $this->assertSame(41583, TenantStock::monthly('year', 49900, 499000));
        $this->assertSame(124916, TenantStock::monthly('year', 149900, 1499000));
        $sub = fn (string $status, bool $paid, string $plan = 'starter') => ['status' => $status, 'interval' => 'month', 'plan_code' => $plan,
            'price_amount' => 49900, 'price_yearly_amount' => 499000, 'has_paid_invoice' => $paid];
        $this->assertSame(['mrr_amount' => 49900, 'is_comp' => false], array_intersect_key(TenantStock::fromCurrent('active', $sub('active', true)), ['mrr_amount' => 1, 'is_comp' => 1]));
        $this->assertSame(['mrr_amount' => 49900, 'is_comp' => false], array_intersect_key(TenantStock::fromCurrent('active', $sub('past_due', true)), ['mrr_amount' => 1, 'is_comp' => 1]));
        $this->assertSame(['mrr_amount' => 0, 'is_comp' => true], array_intersect_key(TenantStock::fromCurrent('active', $sub('active', false)), ['mrr_amount' => 1, 'is_comp' => 1]));
        $this->assertSame(0, TenantStock::fromCurrent('suspended', $sub('active', true))['mrr_amount']);
        $this->assertSame(0, TenantStock::fromCurrent('active', $sub('trialing', false))['mrr_amount']);
        $this->assertSame(TenantStock::TRIALING, TenantStock::category(TenantStock::fromCurrent('active', $sub('trialing', false))));
        $this->assertSame(TenantStock::FREE, TenantStock::category(TenantStock::fromCurrent('active', $sub('active', false, 'free'))));
        $this->assertSame(['plan_code' => 'free', 'mrr_amount' => 0], array_intersect_key(TenantStock::fromCurrent('active', null), ['plan_code' => 1, 'mrr_amount' => 1]));
    }

    public function test_ranges_buckets_and_previous_periods(): void
    {
        $w = AnalyticsWindow::resolve([], '2026-11-22', '30d');
        $this->assertSame(['30d', 'day', '2026-10-24', '2026-11-22', '2026-09-24', '2026-10-23'], [$w->range, $w->granularity, $w->from, $w->to, $w->previousFrom, $w->previousTo]);
        $this->assertCount(30, $w->buckets);

        $q = AnalyticsWindow::resolve(['range' => 'quarter'], '2026-11-22', '30d'); // 90 days, ISO weeks clipped
        $this->assertSame(['week', '2026-08-25', '2026-05-27', '2026-08-24'], [$q->granularity, $q->from, $q->previousFrom, $q->previousTo]);
        $this->assertSame(['2026-08-25', '2026-08-30'], $q->buckets[0]); // Tue … Sun
        $this->assertSame(['2026-08-31', '2026-09-06'], $q->buckets[1]);
        $this->assertSame(['2026-11-16', '2026-11-22'], $q->buckets[count($q->buckets) - 1]);

        $m = AnalyticsWindow::resolve(['range' => '12m'], '2026-11-22', '30d');
        $this->assertSame(['month', '2025-12-01', '2026-11-22', '2024-12-01', '2025-11-30'], [$m->granularity, $m->from, $m->to, $m->previousFrom, $m->previousTo]);
        $this->assertCount(12, $m->buckets);
        $this->assertSame(['2026-11-01', '2026-11-22'], $m->buckets[count($m->buckets) - 1]);

        $c = AnalyticsWindow::resolve(['range' => 'custom', 'from' => '2026-09-01', 'to' => '2026-12-31'], '2026-11-22', '30d');
        $this->assertSame(['week', '2026-11-22', '2026-06-10', '2026-08-31'], [$c->granularity, $c->to, $c->previousFrom, $c->previousTo]); // 83 days, to clamped
        $this->assertSame('day', AnalyticsWindow::resolve(['range' => 'custom', 'from' => '2026-11-01', 'to' => '2026-11-22'], '2026-11-22', '30d')->granularity);
        $this->assertSame('month', AnalyticsWindow::resolve(['range' => 'custom', 'from' => '2026-01-01', 'to' => '2026-11-22'], '2026-11-22', '30d')->granularity);

        // stocks = value on the bucket's last day, flows = sum, missing rows → null
        $t = $this->aTenant('Flow', '2026-01-01 10:00');
        $this->night('2026-11-20', [$t => 1000]);
        $this->night('2026-11-22', [$t => 2000]);
        $this->platformTable('platform_daily_metrics')->where('day', '2026-11-20')->update(['gmv_amount' => 300, 'orders_count' => 1]);
        $this->platformTable('platform_daily_metrics')->where('day', '2026-11-22')->update(['gmv_amount' => 700, 'orders_count' => 2]);
        $this->travelToDhaka('2026-11-23 09:00');
        $o = $this->analytics($this->staff, 'admin/analytics/overview?range=custom&from=2026-11-19&to=2026-11-22')->assertOk();
        $this->assertSame([null, 1000, null, 2000], array_column($o->json('data.mrr_series'), 'mrr_amount'));
        $o->assertJsonPath('data.gmv.amount', 1000)->assertJsonPath('data.gmv.orders_count', 3)->assertJsonPath('data.mrr.previous_amount', null);
        $this->analytics($this->staff, 'admin/analytics/revenue?range=custom&from=2026-11-21&to=2026-11-22&granularity=day')->assertOk()
            ->assertJsonPath('data.movement.0.opening_mrr_amount', null)->assertJsonPath('data.movement.0.counts', null) // 2026-11-20 → 21: no row on 21
            ->assertJsonPath('data.movement.1.opening_mrr_amount', null);
    }
}
