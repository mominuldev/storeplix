<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Analytics;

use App\Domain\Admin\Analytics\MetricsAggregator;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\AnalyticsFixtures;
use Tests\TestCase;

/** PHASE-8-2 §4.1 / §4.2 / §10 `AnalyticsAggregateTest` (P82-3 – P82-6, S89). */
#[Group('analytics')]
class AnalyticsAggregateTest extends TestCase
{
    use AnalyticsFixtures, RefreshDatabase;

    private const STOCK_COLUMNS = ['plan_code', 'billing_interval', 'subscription_status', 'tenant_status', 'mrr_amount', 'is_comp', 'source', 'snapshot_at'];

    /** @return array<string, array<string, mixed>> */
    private function rows(string $day): array
    {
        return $this->platformTable('tenant_daily_metrics')->where('day', $day)->orderBy('tenant_id')->get()
            ->mapWithKeys(fn ($r) => [(string) $r->tenant_id => array_diff_key((array) $r, ['computed_at' => 1])])->all();
    }

    /** @return array{0: string, 1: string} tenant id, subscription id (Starter, paid) */
    private function payingShop(string $name = 'Paying'): array
    {
        $t = $this->aTenant($name, '2026-09-01 10:00');
        $s = $this->aSubscription($t, 'starter', 'active', createdAt: '2026-09-01 10:00');
        $this->aPaidInvoice($t, $s, 'starter', '2026-11-01 10:00');

        return [$t, $s];
    }

    public function test_the_catch_up_fills_seven_days_is_idempotent_and_does_nothing_when_complete(): void
    {
        [$t] = $this->payingShop();
        $this->anOrder($t, 'delivered', 1000, '2026-11-21 10:00');
        $this->travelToDhaka('2026-11-23 00:20');
        $this->artisan('analytics:aggregate')->expectsOutputToContain('created 7 day(s)')->assertExitCode(0);
        $this->assertSame(7, $this->platformTable('platform_daily_metrics')->count());
        $this->assertSame('nightly', $this->platformRow('2026-11-22')->source); // before 06:00 the next morning
        $this->assertSame('late', $this->platformRow('2026-11-21')->source);
        $first = $this->rows('2026-11-21');

        $this->artisan('analytics:aggregate')->expectsOutputToContain('created 0 day(s)')->assertExitCode(0);
        $this->artisan('analytics:aggregate', ['--date' => '2026-11-21'])->assertExitCode(0); // re-run = restate
        $this->assertSame($first, $this->rows('2026-11-21'));
        $this->assertSame(1000, (int) $this->platformRow('2026-11-21')->gmv_amount);

        // a gap within 7 days is filled by the next catch-up; a missing day older than 7 days is refused
        $this->platformTable('tenant_daily_metrics')->where('day', '2026-11-19')->delete();
        $this->platformTable('platform_daily_metrics')->where('day', '2026-11-19')->delete();
        $this->travelToDhaka('2026-11-23 07:20');
        $this->artisan('analytics:aggregate')->expectsOutputToContain('created 1 day(s) (2026-11-19)')->assertExitCode(0);
        $this->assertSame('late', $this->platformRow('2026-11-19')->source);
        $this->artisan('analytics:aggregate', ['--date' => '2026-11-10'])->expectsOutputToContain('use analytics:backfill')->assertExitCode(1);
        $this->assertNull($this->platformRow('2026-11-10'));
    }

    /** S89: re-running a closed day after a plan change keeps every stock column and restates flows. */
    public function test_closed_day_stocks_are_insert_only_and_flows_are_restated(): void
    {
        [$t, $s] = $this->payingShop();
        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate(['--date' => '2026-11-22']);
        $before = $this->rows('2026-11-22');

        $this->updateSubscription($s, ['plan' => 'growth']);
        $this->platformTable('tenants')->where('id', $t)->update(['status' => 'suspended']);
        $this->anOrder($t, 'delivered', 5000, '2026-11-22 15:00');
        $this->aggregate(['--date' => '2026-11-22']);

        $after = $this->rows('2026-11-22');
        foreach (self::STOCK_COLUMNS as $c) {
            $this->assertSame($before[$t][$c], $after[$t][$c], $c);
        }
        $this->assertSame([5000, 1], [(int) $after[$t]['gmv_amount'], (int) $after[$t]['orders_count']]);
        $p = $this->platformRow('2026-11-22');
        $this->assertSame([49900, 1, 0, 5000], [(int) $p->mrr_amount, (int) $p->paying_tenants, (int) $p->suspended_tenants, (int) $p->gmv_amount]);
    }

    /** PHASE-8-2 §4.3 amendment: today (local/testing only) is recomputed on every run, stocks and platform row. */
    public function test_today_is_replaced_on_every_run_while_closed_days_are_not(): void
    {
        $this->travelToDhaka('2026-11-23 15:00');
        $t = $this->aTenant('Trial', '2026-11-20 10:00');
        $s = $this->aSubscription($t, 'starter', 'trialing', trialEndsAt: '2026-12-04 10:00', createdAt: '2026-11-20 10:00');
        $this->aggregate(['--from' => '2026-11-22', '--to' => '2026-11-23']);
        $this->assertSame('trialing', $this->tenantRow($t, '2026-11-23')->subscription_status);
        $this->assertSame([0, 1], [(int) $this->platformRow('2026-11-23')->mrr_amount, (int) $this->platformRow('2026-11-23')->trialing_tenants]);

        $this->updateSubscription($s, ['status' => 'active', 'trial_ends_at' => null]); // pays between two same-day runs
        $this->aPaidInvoice($t, $s, 'starter', '2026-11-23 15:30');
        $this->travelToDhaka('2026-11-23 15:40');
        $this->aggregate(['--from' => '2026-11-22', '--to' => '2026-11-23']);

        $today = $this->tenantRow($t, '2026-11-23');
        $this->assertSame([49900, 'active', 'late'], [(int) $today->mrr_amount, $today->subscription_status, $today->source]);
        $p = $this->platformRow('2026-11-23');
        $this->assertSame([49900, 1, 0], [(int) $p->mrr_amount, (int) $p->paying_tenants, (int) $p->trialing_tenants]);
        $this->assertSame(['trialing', 0], [$this->tenantRow($t, '2026-11-22')->subscription_status, (int) $this->tenantRow($t, '2026-11-22')->mrr_amount]);
        $this->assertSame(1, (int) $this->platformRow('2026-11-22')->trialing_tenants);
    }

    public function test_unclosed_days_are_refused_outside_local_and_testing(): void
    {
        $this->travelToDhaka('2026-11-23 15:00');
        $this->artisan('analytics:aggregate', ['--date' => '2026-11-24'])->expectsOutputToContain('not a closed day')->assertExitCode(1);
        $this->app['env'] = 'staging';
        $this->artisan('analytics:aggregate', ['--date' => '2026-11-23'])->expectsOutputToContain('not a closed day')->assertExitCode(1);
        $this->assertSame(0, $this->platformTable('platform_daily_metrics')->count());
        $this->app['env'] = 'production';
        $this->artisan('analytics:aggregate', ['--date' => '2026-11-20', '--rebuild-stocks' => true])->expectsOutputToContain('--force')->assertExitCode(1);
        $this->artisan('analytics:backfill', ['--from' => '2026-11-01'])->expectsOutputToContain('--force')->assertExitCode(1);
    }

    /** §4.1 step 4: a failed identity rolls the whole day back. */
    public function test_an_assertion_failure_rolls_the_day_back(): void
    {
        [$t] = $this->payingShop();
        $broken = $this->aTenant('Broken', '2026-09-01 10:00');
        $this->platformTable('tenant_daily_metrics')->insert(['tenant_id' => $broken, 'day' => '2026-11-22', 'plan_code' => null,
            'tenant_status' => 'active', 'mrr_amount' => 100, 'is_comp' => false, 'source' => 'nightly']); // MRR without a plan
        $this->anOrder($t, 'delivered', 5000, '2026-11-22 15:00');
        $this->travelToDhaka('2026-11-23 00:20');
        Log::spy();

        $this->artisan('analytics:aggregate', ['--date' => '2026-11-22'])->expectsOutputToContain('rolled back')->assertExitCode(1);

        $this->assertNull($this->platformRow('2026-11-22'));
        $this->assertNull($this->tenantRow($t, '2026-11-22'));
        Log::shouldHaveReceived('error')->withArgs(fn ($m, $ctx) => $m === 'analytics.aggregate_failed' && $ctx['day'] === '2026-11-22')->once();
    }

    public function test_backfill_reconstructs_stocks_from_invoices_and_refuses_nightly_rows(): void
    {
        $paid = $this->aTenant('Monthly', '2026-06-01 10:00');
        $s = $this->aSubscription($paid, 'starter', 'active', createdAt: '2026-06-01 10:00', trialEndsAt: '2026-06-15 10:00');
        $this->aPaidInvoice($paid, $s, 'starter', '2026-06-15 10:00', periodStart: '2026-06-15 10:00', periodEnd: '2026-07-15 10:00');
        // gap 2026-07-15 … 2026-08-01, then paid again
        $this->aPaidInvoice($paid, $s, 'starter', '2026-08-01 10:00', periodStart: '2026-08-01 10:00', periodEnd: '2026-09-01 10:00');
        $yearly = $this->aTenant('Yearly', '2026-06-01 10:00');
        $ys = $this->aSubscription($yearly, 'growth', 'active', 'year', createdAt: '2026-06-01 10:00');
        $this->aPaidInvoice($yearly, $ys, 'growth', '2026-06-01 11:00', 'year');
        $late = $this->aTenant('Later', '2026-06-20 10:00');

        $this->travelToDhaka('2026-11-23 00:20');
        $this->aggregate(['--date' => '2026-11-22']); // first nightly row
        $this->artisan('analytics:backfill', ['--from' => '2026-06-10'])->expectsOutputToContain('2026-11')->assertExitCode(0);

        $this->assertSame('2026-11-21', substr((string) $this->platformTable('platform_daily_metrics')->where('source', 'backfill')->max('day'), 0, 10));
        $trial = $this->tenantRow($paid, '2026-06-10');
        $this->assertSame(['starter', 'trialing', 0, 'backfill'], [$trial->plan_code, $trial->subscription_status, (int) $trial->mrr_amount, $trial->source]);
        $this->assertSame(49900, (int) $this->tenantRow($paid, '2026-06-20')->mrr_amount);
        $gap = $this->tenantRow($paid, '2026-07-20');
        $this->assertSame(['free', null, 0], [$gap->plan_code, $gap->subscription_status, (int) $gap->mrr_amount]);
        $this->assertSame([124916, 'year'], [(int) $this->tenantRow($yearly, '2026-07-20')->mrr_amount, $this->tenantRow($yearly, '2026-07-20')->billing_interval]);
        $this->assertNull($this->tenantRow($late, '2026-06-19'));
        $this->assertNull($this->tenantRow($late, '2026-06-20')->plan_code); // no subscription row yet
        $this->assertSame('nightly', $this->platformRow('2026-11-22')->source);

        $this->artisan('analytics:backfill', ['--from' => '2026-11-20', '--to' => '2026-11-22'])->expectsOutputToContain('Refusing')->assertExitCode(1);

        // --rebuild-stocks overwrites a nightly day with the reconstruction
        $this->updateSubscription($s, ['plan' => 'growth']); // comp-like current state, invisible to the reconstruction
        $this->aggregate(['--date' => '2026-11-22', '--rebuild-stocks' => true]);
        $this->assertSame(['backfill', 0], [$this->platformRow('2026-11-22')->source, (int) $this->tenantRow($paid, '2026-11-22')->mrr_amount]);
    }

    public function test_the_scheduler_runs_the_catch_up_hourly_at_twenty_past_in_dhaka(): void
    {
        $event = collect(app(Schedule::class)->events())->first(fn ($e) => str_contains($e->command ?? '', 'analytics:aggregate'));

        $this->assertNotNull($event);
        $this->assertSame('20 * * * *', $event->expression);
        $this->assertSame('Asia/Dhaka', $event->timezone);
        $this->assertTrue($event->withoutOverlapping);
        $this->assertTrue($event->onOneServer);
        $this->assertTrue($event->runInBackground);
        $this->assertInstanceOf(MetricsAggregator::class, app(MetricsAggregator::class));
    }
}
