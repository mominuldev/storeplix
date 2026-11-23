<?php

declare(strict_types=1);

namespace Tests\Feature\Reports;

use App\Domain\Billing\Models\Plan;
use App\Domain\Tenancy\Models\TenantUser;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/**
 * PHASE-7-CONTRACT §6.3–6.4 (7.4): Sales, Profit, Delivery reports. Every expected figure below is worked out by hand
 * from the fixture rows (store timezone Asia/Dhaka unless stated), independently of the report code.
 */
#[Group('reports')]
class ReportsTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, ReportFixtures, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->travelTo(CarbonImmutable::parse('2026-11-20 06:00:00', 'UTC'));
    }

    private const OCT = ['from' => '2026-10-01', 'to' => '2026-10-31'];

    public function test_sales_report_matches_the_orders_in_the_store_timezone(): void
    {
        [, $t, $store, $h] = $this->shop();
        $p1 = strtolower((string) Str::ulid());

        // 23:30 Dhaka on 31 Oct (Saturday): in October. 00:30 Dhaka on 1 Nov: not.
        $a = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-31 17:30:00', 'total' => 100000, 'refunded' => 10000]);
        $this->item($t, $store, $a, ['product_id' => $p1, 'name' => 'Panjabi', 'qty' => 2, 'total' => 80000]);
        $b = $this->order($t, $store, ['status' => 'shipped', 'placed_at' => '2026-10-31 18:30:00', 'total' => 99900]);
        $this->item($t, $store, $b, ['product_id' => $p1, 'name' => 'Panjabi', 'qty' => 5, 'total' => 99900]);
        // Wednesday 7 Oct, Facebook, Chattogram.
        $c = $this->order($t, $store, ['status' => 'shipped', 'placed_at' => '2026-10-07 04:00:00', 'total' => 50000, 'channel' => 'facebook', 'district' => 'chattogram']);
        $this->item($t, $store, $c, ['name' => 'Loose item', 'qty' => 1, 'total' => 45000]);
        $this->item($t, $store, $c, ['product_id' => $p1, 'name' => 'Panjabi', 'qty' => 1, 'total' => 40000]);
        $this->order($t, $store, ['status' => 'cancelled', 'cancel_reason' => 'fake_order', 'placed_at' => '2026-10-10 06:00:00', 'total' => 20000]);
        $this->order($t, $store, ['status' => 'pending_payment', 'placed_at' => '2026-10-11 06:00:00', 'total' => 70000]);
        $abandoned = $this->order($t, $store, ['status' => 'cancelled', 'placed_at' => '2026-10-11 07:00:00', 'total' => 70000]);
        $this->event($t, $store, $abandoned, 'pending_payment', 'cancelled');
        $this->order($t, $store, ['status' => 'pending', 'placed_at' => '2026-10-12 06:00:00', 'total' => 30000, 'channel' => 'whatsapp']);
        $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-09-15 06:00:00', 'total' => 30000]); // previous period

        $r = $this->report($h, $store, 'sales', self::OCT)->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $r->assertJsonPath('meta', [
            'from' => '2026-10-01', 'to' => '2026-10-31', 'previous_from' => '2026-08-31', 'previous_to' => '2026-09-30',
            'timezone' => 'Asia/Dhaka', 'currency' => 'BDT', 'generated_at' => '2026-11-20T06:00:00Z',
        ]);
        $this->assertSame([
            'sales_amount' => 140000, 'sold_orders_count' => 2, 'orders_count' => 4, 'orders_per_day' => 0.1,
            'average_order_value_amount' => 70000, 'items_per_order' => 2, 'cancelled_count' => 1, 'cancelled_rate' => 0.25,
            'fake_cancelled_count' => 1,
        ], $r->json('data.summary'));
        $this->assertSame(140000, $r->json('data.summary.sales_amount'));
        $this->assertSame(1, $r->json('data.previous.orders_count'));
        $this->assertSame(30000, $r->json('data.previous.sales_amount'));
        $this->assertCount(31, $r->json('data.daily'));
        $this->assertSame(['date' => '2026-10-31', 'orders_count' => 1, 'sold_orders_count' => 1, 'sales_amount' => 90000], $r->json('data.daily.30'));
        $this->assertSame(['date' => '2026-10-07', 'orders_count' => 1, 'sold_orders_count' => 1, 'sales_amount' => 50000], $r->json('data.daily.6'));
        $r->assertJsonPath('data.best_day', ['date' => '2026-10-31', 'sales_amount' => 90000, 'orders_count' => 1]);
        $this->assertEquals(round(90000 / 140000, 4), $r->json('data.weekend_share'));
        $this->assertEquals([
            ['channel' => 'website', 'orders_count' => 1, 'sales_amount' => 90000, 'share' => round(90000 / 140000, 4)],
            ['channel' => 'facebook', 'orders_count' => 1, 'sales_amount' => 50000, 'share' => round(50000 / 140000, 4)],
        ], $r->json('data.channels'));
        $this->assertEquals([
            ['product_id' => $p1, 'name' => 'Panjabi', 'image' => null, 'units' => 3, 'sales_amount' => 120000, 'share' => round(120000 / 165000, 4)],
            ['product_id' => null, 'name' => 'Loose item', 'image' => null, 'units' => 1, 'sales_amount' => 45000, 'share' => round(45000 / 165000, 4)],
        ], $r->json('data.top_products'));
        $this->assertEquals(round(90000 / 140000, 4), $r->json('data.areas.inside_dhaka_share'));
        $this->assertEquals([
            ['district_code' => 'dhaka', 'district_name' => 'Dhaka', 'orders_count' => 1, 'sales_amount' => 90000, 'share' => round(90000 / 140000, 4)],
            ['district_code' => 'chattogram', 'district_name' => 'Chattogram', 'orders_count' => 1, 'sales_amount' => 50000, 'share' => round(50000 / 140000, 4)],
        ], $r->json('data.areas.districts'));
    }

    public function test_other_timezones_bucket_by_local_day(): void
    {
        [, $t, $store, $h] = $this->shop();
        $this->setTimezone($t, $store, 'America/New_York');
        // 03:00 UTC on 1 Oct = 23:00 on 30 Sep in New York.
        $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-01 03:00:00', 'total' => 10000]);

        $this->report($h, $store, 'sales', self::OCT)->assertOk()
            ->assertJsonPath('data.summary.orders_count', 0)->assertJsonPath('meta.timezone', 'America/New_York')
            ->assertJsonPath('data.best_day', null)->assertJsonPath('data.weekend_share', null);
        $sep = $this->report($h, $store, 'sales', ['from' => '2026-09-01', 'to' => '2026-09-30'])->assertOk();
        $sep->assertJsonPath('data.summary.sales_amount', 10000);
        $this->assertSame(['date' => '2026-09-30', 'orders_count' => 1, 'sold_orders_count' => 1, 'sales_amount' => 10000], $sep->json('data.daily.29'));
    }

    public function test_profit_report_on_growth(): void
    {
        [, $t, $store, $h] = $this->shop();
        $this->onPlan($t, Plan::GROWTH);

        $p = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-01 10:00:00', 'delivered_at' => '2026-10-05 10:00:00', 'total' => 100000]);
        $i1 = $this->item($t, $store, $p, ['qty' => 2, 'total' => 80000, 'cost' => 30000]);
        $this->item($t, $store, $p, ['qty' => 1, 'total' => 20000, 'cost' => null]);
        $this->shipment($t, $store, $p, ['status' => 'delivered', 'booked_at' => '2026-10-02 10:00:00', 'delivered_at' => '2026-10-05 10:00:00', 'fee' => 6000, 'cod_charge' => 1000]);
        $this->returnRequest($t, $store, $p, 'wrong_size', 'received', '2026-10-06 10:00:00', [$i1 => 1]);

        $q = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-15 10:00:00', 'delivered_at' => '2026-10-20 10:00:00', 'total' => 50000, 'refunded' => 5000]);
        $this->item($t, $store, $q, ['qty' => 1, 'total' => 50000, 'cost' => 20000]);
        $this->shipment($t, $store, $q, ['provider' => 'manual', 'status' => 'delivered', 'delivered_at' => '2026-10-20 10:00:00']);

        $returned = $this->order($t, $store, ['status' => 'returned', 'placed_at' => '2026-10-01 10:00:00', 'delivered_at' => '2026-10-10 10:00:00', 'total' => 70000]);
        $this->item($t, $store, $returned, ['qty' => 1, 'total' => 70000, 'cost' => 10000]);
        $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-09-10 10:00:00', 'delivered_at' => '2026-09-20 10:00:00', 'total' => 30000]);

        $r = $this->report($h, $store, 'profit', self::OCT)->assertOk();
        $this->assertSame([
            'revenue_amount' => 145000, 'delivered_orders_count' => 2, 'product_cost_amount' => 50000,
            'delivery_cost_amount' => 6000, 'cod_fee_amount' => 1000, 'gateway_fee_amount' => null, 'ad_spend_amount' => null,
            'total_cost_amount' => 57000, 'net_profit_amount' => 88000, 'margin' => round(88000 / 145000, 4),
            'profit_per_order_amount' => 44000,
        ], $r->json('data.summary'));
        $this->assertSame([
            'order_value_amount' => 72500, 'product_cost_amount' => 25000, 'delivery_cost_amount' => 3000,
            'cod_fee_amount' => 500, 'gateway_fee_amount' => null, 'profit_amount' => 44000,
        ], $r->json('data.per_order'));
        $r->assertJsonPath('data.data_quality', ['items_without_cost' => 1, 'shipments_without_fee' => 1]);
        $r->assertJsonPath('data.previous.revenue_amount', 30000)->assertJsonPath('data.previous.net_profit_amount', 30000);

        $daily = $r->json('data.daily');
        $this->assertCount(31, $daily);
        $this->assertSame('2026-10-31', $daily[0]['date']);
        $oct5 = collect($daily)->firstWhere('date', '2026-10-05');
        $this->assertEquals(['date' => '2026-10-05', 'orders_count' => 1, 'revenue_amount' => 100000, 'product_cost_amount' => 30000,
            'delivery_cost_amount' => 6000, 'cod_fee_amount' => 1000, 'gateway_fee_amount' => null, 'ad_spend_amount' => null,
            'total_cost_amount' => 37000, 'net_profit_amount' => 63000, 'margin' => 0.63], $oct5);

        $weekly = $r->json('data.weekly');
        $this->assertCount(12, $weekly);
        $this->assertSame(['week' => '2026-W44', 'week_start' => '2026-10-26'], array_slice($weekly[11], 0, 2));
        $this->assertEquals(['week' => '2026-W41', 'week_start' => '2026-10-05', 'revenue_amount' => 100000, 'net_profit_amount' => 63000, 'margin' => 0.63], $weekly[8]);
        $this->assertEquals(['week' => '2026-W43', 'week_start' => '2026-10-19', 'revenue_amount' => 45000, 'net_profit_amount' => 25000, 'margin' => round(25000 / 45000, 4)], $weekly[10]);
        $this->assertSame(0, $weekly[0]['revenue_amount']);
        $this->assertNull($weekly[0]['margin']);
    }

    public function test_profit_empty_range_has_null_per_order(): void
    {
        [, $t, $store, $h] = $this->shop();
        $this->onPlan($t, Plan::GROWTH);
        $this->report($h, $store, 'profit', self::OCT)->assertOk()
            ->assertJsonPath('data.per_order', null)->assertJsonPath('data.summary.margin', null)
            ->assertJsonPath('data.summary.profit_per_order_amount', null);
    }

    public function test_delivery_report(): void
    {
        [, $t, $store, $h] = $this->shop();
        $o1 = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1]);
        $o2 = $this->order($t, $store, ['status' => 'returned', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1, 'district' => 'chattogram']);
        $o3 = $this->order($t, $store, ['status' => 'shipped', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1, 'district' => 'sylhet', 'customer_name' => 'Karim']);
        $o4 = $this->order($t, $store, ['status' => 'shipped', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1]);
        $o5 = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1, 'district' => 'chattogram']);
        $o6 = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1]);
        $o7 = $this->order($t, $store, ['status' => 'confirmed', 'placed_at' => '2026-10-04 10:00:00', 'total' => 1]);
        $o8 = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-09-18 10:00:00', 'total' => 1]);

        $this->shipment($t, $store, $o1, ['status' => 'delivered', 'booked_at' => '2026-10-05 10:00:00', 'picked_up_at' => '2026-10-06 10:00:00', 'delivered_at' => '2026-10-08 10:00:00', 'fee' => 6000, 'cod_collected' => 50000]);
        $this->shipment($t, $store, $o2, ['status' => 'returned', 'booked_at' => '2026-10-06 10:00:00', 'fee' => 13000]);
        $s3 = $this->shipment($t, $store, $o3, ['provider' => 'pathao', 'status' => 'returning', 'booked_at' => '2026-10-07 10:00:00', 'fee' => 11000,
            'problem' => 'returning', 'last_location' => 'Sylhet hub', 'last_event_at' => '2026-10-09 10:00:00']);
        $this->shipment($t, $store, $o4, ['provider' => 'pathao', 'status' => 'in_transit', 'booked_at' => '2026-10-08 10:00:00']);
        $this->shipment($t, $store, $o5, ['status' => 'delivered', 'booked_at' => '2026-10-10 10:00:00', 'delivered_at' => '2026-10-13 10:00:00']);
        $this->shipment($t, $store, $o4, ['status' => 'cancelled', 'booked_at' => '2026-10-11 10:00:00']);
        $this->shipment($t, $store, $o6, ['provider' => 'manual', 'status' => 'delivered', 'booked_at' => '2026-10-11 10:00:00', 'delivered_at' => '2026-10-12 10:00:00']);
        $this->shipment($t, $store, $o7, ['status' => 'booking_failed', 'booked_at' => '2026-10-12 10:00:00']);
        $this->shipment($t, $store, $o8, ['provider' => 'redx', 'status' => 'delivered', 'booked_at' => '2026-09-20 10:00:00', 'delivered_at' => '2026-09-21 10:00:00', 'cod_collected' => 7000]);

        $this->returnRequest($t, $store, $o1, 'wrong_size', 'requested', '2026-10-12 10:00:00');
        $this->returnRequest($t, $store, $o2, 'wrong_size', 'received', '2026-10-14 10:00:00');
        $this->returnRequest($t, $store, $o4, 'damaged', 'requested', '2026-10-15 10:00:00');
        $this->returnRequest($t, $store, $o5, 'damaged', 'requested', '2026-09-01 10:00:00');

        $r = $this->report($h, $store, 'delivery', self::OCT)->assertOk();
        $this->assertSame([
            'parcels_count' => 5, 'delivered_count' => 2, 'returned_count' => 1, 'returning_count' => 1, 'in_progress_count' => 1,
            'success_rate' => 0.4, 'return_rate' => 0.2, 'returning_charges_amount' => 24000,
            'avg_delivery_days' => 2.5, 'avg_delivery_days_inside_dhaka' => 2, 'avg_delivery_days_outside_dhaka' => 3,
        ], $r->json('data.summary'));
        $r->assertJsonPath('data.previous.parcels_count', 1)->assertJsonPath('data.previous.success_rate', 1);
        $this->assertEquals([
            ['provider' => 'steadfast', 'parcels_count' => 3, 'delivered_share' => 0.6667, 'returned_share' => 0.3333, 'in_progress_share' => 0.0, 'avg_delivery_days' => 2.5, 'cod_held_amount' => 50000],
            ['provider' => 'pathao', 'parcels_count' => 2, 'delivered_share' => 0.0, 'returned_share' => 0.0, 'in_progress_share' => 1.0, 'avg_delivery_days' => null, 'cod_held_amount' => 0],
        ], $r->json('data.couriers'));
        $r->assertJsonPath('data.returns_count', 3);
        $this->assertEquals([['reason' => 'wrong_size', 'count' => 2, 'share' => 0.6667], ['reason' => 'damaged', 'count' => 1, 'share' => 0.3333]], $r->json('data.return_reasons'));
        $weekly = $r->json('data.weekly');
        $this->assertCount(8, $weekly);
        $this->assertEquals(['week' => '2026-W41', 'week_start' => '2026-10-05', 'parcels_count' => 5, 'success_rate' => 0.4], $weekly[4]);
        $this->assertEquals([
            ['district_code' => 'chattogram', 'district_name' => 'Chattogram', 'parcels_count' => 2, 'success_rate' => 0.5],
            ['district_code' => 'dhaka', 'district_name' => 'Dhaka', 'parcels_count' => 2, 'success_rate' => 0.5],
            ['district_code' => 'sylhet', 'district_name' => 'Sylhet', 'parcels_count' => 1, 'success_rate' => 0.0],
        ], $r->json('data.districts'));

        // S63: names + district only; no phone or address.
        $this->assertSame([[
            'shipment_id' => $s3, 'order_id' => $o3, 'order_number' => $r->json('data.returning.0.order_number'), 'customer_name' => 'Karim',
            'district_name' => 'Sylhet', 'provider' => 'pathao', 'problem' => 'returning', 'last_location' => 'Sylhet hub',
            'last_event_at' => '2026-10-09T10:00:00Z',
        ]], $r->json('data.returning'));
        $this->assertStringNotContainsString('8801711000000', $r->getContent());
        $this->assertStringNotContainsString('Secret Road', $r->getContent());
    }

    #[Group('security')]
    public function test_access_by_role_and_plan(): void
    {
        [, $t, $store, $h] = $this->shop(); // Starter trial
        [, $staff] = $this->member($t, TenantUser::ROLE_STAFF);
        [, $admin] = $this->member($t, TenantUser::ROLE_ADMIN);

        $this->report($h, $store, 'profit')->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan')
            ->assertJsonPath('error.details.feature', ['profit_reports']);
        $this->report($staff, $store, 'profit')->assertForbidden(); // role first, then plan
        $this->report($staff, $store, 'sales')->assertOk();
        $this->report($staff, $store, 'delivery')->assertOk();

        $this->onPlan($t, Plan::GROWTH);
        $this->report($h, $store, 'profit')->assertOk();
        $this->report($admin, $store, 'profit')->assertOk();
        $this->report($staff, $store, 'profit')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    public function test_range_validation_defaults_and_clipping(): void
    {
        [, , $store, $h] = $this->shop();

        // Default: 1st of the current local month → today (2026-11-20 12:00 Dhaka).
        $this->report($h, $store, 'sales')->assertOk()->assertJsonPath('meta.from', '2026-11-01')->assertJsonPath('meta.to', '2026-11-20')
            ->assertJsonPath('meta.previous_from', '2026-10-12')->assertJsonPath('meta.previous_to', '2026-10-31')
            ->assertJsonCount(20, 'data.daily')->assertJsonPath('data.summary.orders_per_day', 0);
        // `to` in the future is clipped to today.
        $this->report($h, $store, 'delivery', ['from' => '2026-11-10', 'to' => '2027-01-01'])->assertOk()->assertJsonPath('meta.to', '2026-11-20');

        foreach ([
            [['from' => '2026-10-10', 'to' => '2026-10-01'], 'from'],
            [['from' => '2025-01-01', 'to' => '2026-10-01'], 'to'],
            [['from' => '2019-12-31'], 'from'],
            [['from' => '10/01/2026'], 'from'],
            [['to' => '2026-02-30'], 'to'],
            [['from' => '2026-12-01'], 'from'], // after today once `to` is clipped
        ] as [$query, $field]) {
            $this->report($h, $store, 'sales', $query)->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => [$field]]]);
        }
        $this->report($h, $store, 'sales', ['from' => '2025-10-01', 'to' => '2026-10-01'])->assertOk(); // 366 days
    }

    public function test_results_are_cached_per_range_for_120_seconds(): void
    {
        [, $t, $store, $h] = $this->shop();
        $first = $this->report($h, $store, 'sales', self::OCT)->assertOk()->json('meta.generated_at');
        $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-03 06:00:00', 'total' => 5000]);
        $this->travel(30)->seconds();
        $this->report($h, $store, 'sales', self::OCT)->assertJsonPath('meta.generated_at', $first)->assertJsonPath('data.summary.sales_amount', 0);
        $this->report($h, $store, 'sales', ['from' => '2026-10-02', 'to' => '2026-10-31'])->assertJsonPath('data.summary.sales_amount', 5000);
        $this->travel(100)->seconds();
        $this->report($h, $store, 'sales', self::OCT)->assertJsonPath('data.summary.sales_amount', 5000);
    }

    #[Group('tenancy')]
    #[Group('security')]
    public function test_cross_tenant_store_is_404_and_data_never_leaks(): void
    {
        [, $tA, $storeA, $hA] = $this->shop();
        [, $tB, $storeB] = $this->shop(slug: 'other');
        $this->onPlan($tA, Plan::GROWTH);
        $b = $this->order($tB, $storeB, ['status' => 'delivered', 'placed_at' => '2026-10-03 06:00:00', 'delivered_at' => '2026-10-04 06:00:00', 'total' => 5000]);
        $this->shipment($tB, $storeB, $b, ['status' => 'returning', 'booked_at' => '2026-10-03 06:00:00']);

        $this->assertTenantIsolation($hA, [
            ['GET', "/api/v1/stores/{$storeB->id}/reports/sales"],
            ['GET', "/api/v1/stores/{$storeB->id}/reports/profit"],
            ['GET', "/api/v1/stores/{$storeB->id}/reports/delivery"],
        ]);
        $this->report($hA, $storeA, 'sales', self::OCT)->assertJsonPath('data.summary.orders_count', 0);
        $this->report($hA, $storeA, 'profit', self::OCT)->assertJsonPath('data.summary.delivered_orders_count', 0);
        $this->report($hA, $storeA, 'delivery', self::OCT)->assertJsonPath('data.summary.parcels_count', 0)->assertJsonPath('data.returning', []);
    }
}
