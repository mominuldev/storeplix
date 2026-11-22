<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/** GET /shipments (filters, groups, sort, counts, KPIs incl. P5B-43 cod_held), detail, batch read, tenancy (§4.7). */
#[Group('couriers')]
class ShipmentListTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_list_filters_groups_sort_counts_and_kpis(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $url = "/api/v1/stores/{$store->id}/shipments";
        $ids = [];
        foreach (['booked', 'in_transit', 'delivery_failed', 'delivered', 'returned'] as $i => $target) {
            $order = $this->confirmedOrder($h, $store, $variant, $i + 1, ['contact' => ['phone' => '0171100000'.$i]]);
            $sid = $this->book($h, $store, $order)->assertCreated()->json('data.id');
            $ids[$target] = [$order, $sid];
            $path = match ($target) {
                'in_transit' => ['in_transit'],
                'delivery_failed' => ['in_transit', 'delivery_failed'],
                'delivered' => ['in_transit', 'delivered'],
                'returned' => ['in_transit', 'returning', 'returned'],
                default => [],
            };
            foreach ($path as $status) {
                $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$sid}/advance", ['status' => $status])->assertOk();
            }
        }
        // A manual 5a shipment shows up under `manual`.
        $manual = $this->confirmedOrder($h, $store, $variant);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$manual}/ship", ['carrier_name' => 'Sundarban', 'tracking_code' => 'SB1', 'tracking_url' => 'https://sb.test/SB1'])->assertOk();

        $r = $this->api($h, 'GET', $url)->assertOk()->assertJsonCount(6, 'data')
            ->assertJsonPath('meta.counts', ['all' => 6, 'steadfast' => 5, 'pathao' => 0, 'redx' => 0, 'manual' => 1])
            ->assertJsonPath('meta.total', 6);
        $this->assertSame(['id', 'number', 'customer_name', 'customer_phone', 'district', 'thana'], array_keys($r->json('data.0.order')));
        $kpis = $r->json('meta.kpis');
        $delivered = $this->shipmentRow($tenant, $ids['delivered'][1]);
        $this->assertSame(1, $kpis['in_transit']);
        $this->assertSame(1, $kpis['delivered_7d']);
        $this->assertSame(0.5, $kpis['delivery_rate_7d']);
        $this->assertSame(['total' => 1, 'delivery_failed' => 1, 'on_hold' => 0, 'returning' => 0], $kpis['problems']);
        $this->assertSame(['total_amount' => $delivered->cod_collected_amount, 'by_provider' => [['provider' => 'steadfast', 'amount' => $delivered->cod_collected_amount, 'parcels' => 1]]], $kpis['cod_held']);
        $this->assertNull($r->json('meta.last_synced_at'));

        $this->api($h, 'GET', "{$url}?filter[provider]=manual")->assertJsonCount(1, 'data')->assertJsonPath('data.0.carrier_name', 'Sundarban')
            ->assertJsonPath('meta.counts.all', 6); // provider tabs keep their counts
        $this->api($h, 'GET', "{$url}?filter[status]=problems")->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $ids['delivery_failed'][1])
            ->assertJsonPath('meta.counts.all', 6)->assertJsonPath('meta.total', 1); // counts are store-wide
        $this->api($h, 'GET', "{$url}?filter[status]=final")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "{$url}?filter[status]=active")->assertJsonCount(4, 'data'); // booked, in_transit, delivery_failed, manual shipped
        $this->api($h, 'GET', "{$url}?filter[status]=booked,returned")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "{$url}?filter[booked_at][gte]=".now()->addDay()->toDateString())->assertJsonCount(0, 'data');
        $this->api($h, 'GET', "{$url}?q=".$this->shipmentRow($tenant, $ids['booked'][1])->consignment_id)->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $ids['booked'][1]);
        $this->api($h, 'GET', "{$url}?q=01711000003")->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $ids['delivered'][1]);
        $number = $this->orderRow2($tenant, $ids['returned'][0])->number;
        $this->api($h, 'GET', "{$url}?q={$number}")->assertJsonCount(1, 'data')->assertJsonPath('data.0.order.number', $number);
        $sorted = $this->api($h, 'GET', "{$url}?sort=-cod&per_page=2")->assertJsonCount(2, 'data')->assertJsonPath('meta.last_page', 3);
        $this->assertGreaterThanOrEqual($sorted->json('data.1.cod_amount'), $sorted->json('data.0.cod_amount'));
        foreach (['filter[status]=lost', 'filter[provider]=dhl', 'sort=cod', 'per_page=101', 'filter[foo]=1'] as $bad) {
            $this->api($h, 'GET', "{$url}?{$bad}")->assertStatus(422);
        }

        // Detail: events newest first, money, parcel.
        $d = $this->api($h, 'GET', "{$url}/{$ids['returned'][1]}")->assertOk()->assertJsonPath('data.status', 'returned')
            ->assertJsonPath('data.events.0.status', 'returned')->assertJsonPath('data.parcel.weight_grams', 500);
        $this->assertCount(4, $d->json('data.events'));
        $this->assertStringContainsString('5×', $d->json('data.parcel.items_summary'));
    }

    #[Group('tenancy')]
    #[Group('security')]
    public function test_foreign_shipments_batches_and_orders_are_404(): void
    {
        [, , $store, $h, $variant] = $this->courierShop();
        $order = $this->confirmedOrder($h, $store, $variant);
        $sid = $this->book($h, $store, $order)->assertCreated()->json('data.id');
        $batch = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$order]])->assertStatus(202)->json('data.id');

        [, $tenantB, $storeB, $hB, $variantB] = $this->courierShop('steadfast', 'other');
        $orderB = $this->confirmedOrder($hB, $storeB, $variantB);
        // B can't read or act on A's shipment / batch through its own store.
        foreach (['GET' => "/shipments/{$sid}", 'POST' => "/shipments/{$sid}/refresh"] as $method => $path) {
            $this->api($hB, $method, "/api/v1/stores/{$storeB->id}{$path}")->assertNotFound();
        }
        foreach (['cancel', 'mark-cancelled'] as $action) {
            $this->api($hB, 'POST', "/api/v1/stores/{$storeB->id}/shipments/{$sid}/{$action}")->assertNotFound();
        }
        $this->api($hB, 'GET', "/api/v1/stores/{$storeB->id}/shipment-batches/{$batch}")->assertNotFound();
        $this->book($hB, $storeB, $order)->assertNotFound();
        // …nor through A's store id.
        $this->api($hB, 'GET', "/api/v1/stores/{$store->id}/shipments")->assertNotFound();
        $this->api($hB, 'POST', "/api/v1/stores/{$storeB->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$orderB, $order]])
            ->assertStatus(422)->assertJsonPath('error.details', ['order_ids.1' => ['Unknown order.']]);
        $this->api($hB, 'GET', "/api/v1/stores/{$storeB->id}/shipments")->assertJsonCount(0, 'data')->assertJsonPath('meta.kpis.cod_held.total_amount', 0);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipments/".strtolower((string) Str::ulid()))->assertNotFound();
        $this->assertSame(0, $this->inTenant($tenantB, fn () => Shipment::query()->count()));
    }

    public function test_dashboard_needs_you_today_and_orders_has_shipment_filter(): void
    {
        [, , $store, $h, $variant] = $this->courierShop();
        $booked = $this->confirmedOrder($h, $store, $variant);
        $sid = $this->book($h, $store, $booked)->assertCreated()->json('data.id');
        $this->confirmedOrder($h, $store, $variant); // to book
        $failed = $this->confirmedOrder($h, $store, $variant);
        $this->book($h, $store, $failed, ['note' => 'fake:reject'])->assertStatus(422); // booking_failed: still to book
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$sid}/advance", ['status' => 'on_hold'])->assertOk();

        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/dashboard")->assertOk()
            ->assertJsonPath('data.orders.waiting.to_book', 2)->assertJsonPath('data.orders.shipments.problems', 1);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[has_shipment]=1")->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $booked);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[has_shipment]=0")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[has_shipment]=2")->assertStatus(422);
    }

    public function test_staff_can_read_and_operate(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $order = $this->confirmedOrder($h, $store, $variant);
        $sid = $this->book($staff, $store, $order)->assertCreated()->json('data.id');
        $this->api($staff, 'GET', "/api/v1/stores/{$store->id}/shipments")->assertOk()->assertJsonCount(1, 'data');
        $this->api($staff, 'POST', "/api/v1/stores/{$store->id}/shipments/{$sid}/mark-cancelled")->assertOk();
    }
}
