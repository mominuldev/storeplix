<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\SteadfastCourier;
use App\Domain\Couriers\Models\CourierAreaMapping;
use App\Domain\Couriers\Models\ShipmentBatch;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RecordingCourier;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/** PHASE-5B §4.7 booking, bulk, cancel (P5B-33…P5B-35, P5B-39…P5B-41), S33, §13 "Couriers". */
#[Group('couriers')]
class ShipmentBookingTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_booking_happy_path_moves_the_order_to_ready_to_ship(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $id = $this->confirmedOrder($h, $store, $variant, 2);
        $r = $this->book($h, $store, $id, ['weight_grams' => 800, 'note' => 'Call first'], 'book-key-0001')->assertCreated()
            ->assertJsonPath('data.status', 'booked')->assertJsonPath('data.provider', 'steadfast')->assertJsonPath('data.carrier_name', 'Steadfast')
            ->assertJsonPath('data.weight_grams', 800)->assertJsonPath('data.delivery_fee_amount', FakeCourier::DELIVERY_FEE)
            ->assertJsonPath('data.provider_status', 'booked');
        $shipmentId = $r->json('data.id');
        $this->assertSame(FakeCourier::consignmentFor('steadfast', $shipmentId), $r->json('data.consignment_id'));
        $order = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")->assertOk()
            ->assertJsonPath('data.status', 'ready_to_ship')->assertJsonPath('data.shipment.id', $shipmentId)
            ->assertJsonPath('data.shipment.status', 'booked')->assertJsonCount(1, 'data.shipments');
        $this->assertSame($order->json('data.due_amount'), $r->json('data.cod_amount')); // P5B-35 COD = due
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders")->assertJsonPath('data.0.shipment.status', 'booked')
            ->assertJsonPath('data.0.shipment.consignment_id', $r->json('data.consignment_id'));
        $this->inTenant($tenant, function () use ($shipmentId) {
            $this->assertSame(['booked'], ShipmentEvent::query()->where('shipment_id', $shipmentId)->pluck('status')->all());
            $this->assertNull(Shipment::query()->findOrFail($shipmentId)->failure_reason);
        });

        // Idempotent replay: same key + body → same shipment, nothing new.
        $this->book($h, $store, $id, ['weight_grams' => 800, 'note' => 'Call first'], 'book-key-0001')->assertCreated()
            ->assertHeader('Idempotent-Replayed', 'true')->assertJsonPath('data.id', $shipmentId);
        // A new key while a parcel is active → 409 shipment_booked.
        $this->book($h, $store, $id)->assertStatus(409)->assertJsonPath('error.code', 'shipment_booked');
        $this->assertSame(1, $this->inTenant($tenant, fn () => Shipment::query()->where('order_id', $id)->count()));
        // Booked parcels block item edits (Q56).
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/orders/{$id}/items", ['revision' => $order->json('data.revision'), 'reason' => 'other',
            'items' => [['id' => $order->json('data.items.0.id'), 'quantity' => 1]]])->assertStatus(409)
            ->assertJsonPath('error.code', 'shipment_booked');
        // …and the manual ship dialog.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/ship", ['carrier_name' => 'Other', 'tracking_code' => 'OT1', 'tracking_url' => 'https://other.test/t/OT1'])->assertStatus(409)
            ->assertJsonPath('error.code', 'shipment_booked');
    }

    public function test_booking_preconditions(): void
    {
        [, , $store, $h, $variant] = $this->courierShop();
        $pending = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->book($h, $store, $pending)->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $id = $this->confirmedOrder($h, $store, $variant);
        $this->book($h, $store, $id, ['provider' => 'pathao'])->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');
        $this->book($h, $store, $id, ['provider' => 'dhl'])->assertStatus(422)->assertJsonPath('error.details.provider.0', fn ($m) => is_string($m));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/shipments", ['provider' => 'steadfast'])->assertStatus(400)
            ->assertJsonPath('error.code', 'idempotency_key_required');
        $this->book($h, $store, $id, ['pickup_location_id' => (string) Str::ulid()])->assertStatus(422)->assertJsonPath('error.details.pickup_location_id.0', 'Unknown pickup location.');
        $this->book($h, $store, $id, ['item_description' => str_repeat('x', 121)])->assertStatus(422);
        // S39: server-owned fields are ignored.
        $r = $this->book($h, $store, $id, ['status' => 'delivered', 'consignment_id' => 'X1', 'cod_collected_amount' => 5])->assertCreated();
        $this->assertSame('booked', $r->json('data.status'));
        $this->assertNull($r->json('data.cod_collected_amount'));
        $this->assertNotSame('X1', $r->json('data.consignment_id'));
    }

    public function test_courier_rejection_marks_booking_failed_and_allows_a_new_booking(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $id = $this->confirmedOrder($h, $store, $variant);
        $this->book($h, $store, $id, ['note' => 'fake:reject'])->assertStatus(422)->assertJsonPath('error.code', 'courier_rejected')
            ->assertJsonPath('error.message', 'Fake courier rejected the address.');
        $failed = $this->inTenant($tenant, fn () => Shipment::query()->where('order_id', $id)->firstOrFail());
        $this->assertSame(['booking_failed', 'Fake courier rejected the address.'], [$failed->status, $failed->failure_reason]);
        $this->assertSame('confirmed', $this->orderRow2($tenant, $id)->status);

        $this->book($h, $store, $id)->assertCreated()->assertJsonPath('data.status', 'booked');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")->assertJsonCount(2, 'data.shipments')
            ->assertJsonPath('data.shipment.status', 'booked');
    }

    public function test_timeout_stays_booking_and_is_reconciled_by_invoice(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $id = $this->confirmedOrder($h, $store, $variant);
        $r = $this->book($h, $store, $id, ['note' => 'fake:timeout'])->assertCreated()->assertJsonPath('data.status', 'booking')
            ->assertJsonPath('data.consignment_id', null);
        $shipmentId = $r->json('data.id');
        $this->assertSame('confirmed', $this->orderRow2($tenant, $id)->status);
        // Still in flight: a second booking is refused (no double booking).
        $this->book($h, $store, $id)->assertStatus(409)->assertJsonPath('error.code', 'shipment_booked');

        $this->artisan('couriers:reconcile-bookings', ['--sync' => true])->assertSuccessful(); // < 1 min old: untouched
        $this->assertSame('booking', $this->shipmentRow($tenant, $shipmentId)->status);
        $this->travel(2)->minutes();
        $this->artisan('couriers:reconcile-bookings', ['--sync' => true])->assertSuccessful();
        $s = $this->shipmentRow($tenant, $shipmentId);
        $this->assertSame(['booked', FakeCourier::consignmentFor('steadfast', $shipmentId)], [$s->status, $s->consignment_id]);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenant, $id)->status);

        // Courier down (nothing created): after 10 minutes the booking gives up.
        $id2 = $this->confirmedOrder($h, $store, $variant);
        $lost = $this->book($h, $store, $id2, ['note' => 'fake:down'])->assertCreated()->assertJsonPath('data.status', 'booking')->json('data.id');
        $this->travel(3)->minutes();
        $this->artisan('couriers:reconcile-bookings', ['--sync' => true]);
        $this->assertSame('booking', $this->shipmentRow($tenant, $lost)->status);
        $this->travel(10)->minutes();
        $this->artisan('couriers:reconcile-bookings', ['--sync' => true]);
        $this->assertSame('booking_failed', $this->shipmentRow($tenant, $lost)->status);
        $this->book($h, $store, $id2)->assertCreated()->assertJsonPath('data.status', 'booked');
    }

    #[Group('security')]
    public function test_s33_cod_override_is_owner_admin_only_bounded_and_audited(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $id = $this->confirmedOrder($h, $store, $variant);
        $this->book($staff, $store, $id, ['cod_amount' => 100])->assertForbidden();
        $this->assertSame(0, $this->inTenant($tenant, fn () => Shipment::query()->count()));
        $total = $this->orderRow2($tenant, $id)->total_amount;
        $this->book($h, $store, $id, ['cod_amount' => $total + 1])->assertStatus(422)->assertJsonPath('error.details.cod_amount.0', fn ($m) => is_string($m));
        $this->book($h, $store, $id, ['cod_amount' => 50000])->assertCreated()->assertJsonPath('data.cod_amount', 50000);
        $this->inTenant($tenant, function () use ($id) {
            $s = Shipment::query()->where('order_id', $id)->firstOrFail();
            $this->assertTrue($s->cod_overridden);
            $log = $this->platformQuery(AuditLog::class)->where('action', 'shipment.cod_overridden')->firstOrFail();
            $this->assertSame($s->id, $log->subject_id);
        });
        // Staff books with the default COD (= due).
        $id2 = $this->confirmedOrder($h, $store, $variant);
        $this->book($staff, $store, $id2)->assertCreated()->assertJsonPath('data.cod_amount', $this->orderRow2($tenant, $id2)->dueAmount());
    }

    public function test_area_mapping_is_required_for_pathao_and_remembered(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop('pathao');
        $id = $this->confirmedOrder($h, $store, $variant);
        $this->book($h, $store, $id, ['provider' => 'pathao'])->assertStatus(422)->assertJsonPath('error.details.area.0', fn ($m) => is_string($m));
        $this->book($h, $store, $id, ['provider' => 'pathao', 'weight_grams' => 200, 'area' => ['city_id' => '1', 'zone_id' => '11', 'area_id' => null]])->assertStatus(422)
            ->assertJsonPath('error.details.weight_grams.0', fn ($m) => is_string($m));
        $this->book($h, $store, $id, ['provider' => 'pathao', 'area' => ['city_id' => '1', 'zone_id' => '11', 'area_id' => '111'], 'remember_area' => true])
            ->assertCreated()->assertJsonPath('data.status', 'booked');
        $this->inTenant($tenant, function () use ($store) {
            $m = CourierAreaMapping::query()->where('store_id', $store->id)->where('provider', 'pathao')->firstOrFail();
            $this->assertSame(['gazipur', 'gazipur-kaliakair', '1', '11', '111'], [$m->district_code, $m->thana_code, $m->provider_city_id, $m->provider_zone_id, $m->provider_area_id]);
        });
        // Next order to the same thana: no area needed.
        $id2 = $this->confirmedOrder($h, $store, $variant);
        $this->book($h, $store, $id2, ['provider' => 'pathao'])->assertCreated()->assertJsonPath('data.status', 'booked');
    }

    public function test_bulk_booking_books_skips_and_reports_per_order(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $a = $this->confirmedOrder($h, $store, $variant);
        $b = $this->confirmedOrder($h, $store, $variant);
        $pending = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $rejected = $this->confirmedOrder($h, $store, $variant, 1, ['contact' => ['name' => 'fake:reject']]);
        $down = $this->confirmedOrder($h, $store, $variant, 1, ['contact' => ['name' => 'fake:down']]);
        $this->book($h, $store, $b)->assertCreated();

        $r = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$a, $b, $pending, $rejected, $down]])
            ->assertStatus(202)->assertJsonPath('data.total', 5);
        $batch = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipment-batches/{$r->json('data.id')}")->assertOk()
            ->assertJsonPath('data.status', 'completed')->assertJsonPath('data.booked', 1)->assertJsonPath('data.skipped', 2)->assertJsonPath('data.failed', 2);
        $results = collect($batch->json('data.results'))->keyBy('order_id');
        $this->assertSame(['booked', null], [$results[$a]['status'], $results[$a]['reason']]);
        $this->assertSame(['skipped', 'shipment_booked'], [$results[$b]['status'], $results[$b]['reason']]);
        $this->assertSame(['skipped', 'invalid_state_transition'], [$results[$pending]['status'], $results[$pending]['reason']]);
        $this->assertSame(['failed', 'courier_rejected'], [$results[$rejected]['status'], $results[$rejected]['reason']]);
        $this->assertSame(['failed', 'provider_unavailable'], [$results[$down]['status'], $results[$down]['reason']]);
        $this->assertSame('booking', $this->shipmentRow($tenant, $results[$down]['shipment_id'])->status); // reconciled later
        $this->assertNotNull($results[$a]['shipment_id']);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenant, $a)->status);
        $this->assertSame($r->json('data.id'), $this->shipmentRow($tenant, $results[$a]['shipment_id'])->batch_id);
    }

    public function test_bulk_validation_plan_and_area_unmapped(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop('pathao');
        $a = $this->confirmedOrder($h, $store, $variant);
        // A foreign / unknown id → 422 on that path, nothing queued.
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'pathao', 'order_ids' => [$a, (string) Str::ulid()]])
            ->assertStatus(422)->assertJsonPath('error.details', ['order_ids.1' => ['Unknown order.']]);
        $this->assertSame(0, $this->inTenant($tenant, fn () => ShipmentBatch::query()->count()));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'pathao', 'order_ids' => array_fill(0, 501, $a)])->assertStatus(422);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => [$a]])
            ->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');

        // Unmapped Pathao area → skipped `area_unmapped`.
        $r = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'pathao', 'order_ids' => [$a]])->assertStatus(202);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipment-batches/{$r->json('data.id')}")
            ->assertJsonPath('data.results.0.status', 'skipped')->assertJsonPath('data.results.0.reason', 'area_unmapped');
        $this->assertSame('confirmed', $this->orderRow2($tenant, $a)->status);

        // Free plan → 402 feature_not_in_plan (Starter+).
        $this->inTenant($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]));
        FeatureGate::forget($tenant->id);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'pathao', 'order_ids' => [$a]])
            ->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
    }

    public function test_bulk_sends_up_to_500_parcels_in_one_courier_request(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop('steadfast', stock: 1000);
        $seed = $this->confirmedOrder($h, $store, $variant);
        $ids = $this->inTenant($tenant, function () use ($seed) {
            $o = Order::query()->findOrFail($seed);
            $ids = [$seed];
            for ($i = 1; $i < 500; $i++) {
                $copy = $o->replicate();
                $copy->number = 'BK-'.(5000 + $i);
                $copy->sequence = 5000 + $i;
                $copy->idempotency_key = null;
                $copy->confirmation_token_hash = null;
                $copy->save();
                $ids[] = $copy->id;
            }

            return $ids;
        });
        // Real-driver path with a recording Steadfast double (no HTTP): one bookBulk call carrying all 500.
        config(['couriers.fake' => false]);
        $spy = new RecordingCourier(new FakeCourier('steadfast', app(TenantCache::class)));
        $this->app->instance(SteadfastCourier::class, $spy);

        $r = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/bulk", ['provider' => 'steadfast', 'order_ids' => $ids])->assertStatus(202);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipment-batches/{$r->json('data.id')}")->assertJsonPath('data.booked', 500);
        $this->assertSame([['bookBulk', 500]], $spy->calls);
    }

    public function test_cancel_is_unsupported_and_mark_cancelled_frees_the_order(): void
    {
        [, $tenant, $store, $h, $variant] = $this->courierShop();
        $id = $this->confirmedOrder($h, $store, $variant);
        $sid = $this->book($h, $store, $id)->assertCreated()->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$sid}/cancel")->assertStatus(409)
            ->assertJsonPath('error.code', 'courier_cancel_unsupported')
            ->assertJsonPath('error.message', 'Cancel it in the Steadfast panel, then mark it cancelled here.');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipments/{$sid}")->assertJsonPath('data.can', ['cancel' => false, 'mark_cancelled' => true, 'refresh' => true]);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$sid}/mark-cancelled", ['note' => 'Cancelled in panel'])->assertOk()
            ->assertJsonPath('data.status', 'cancelled')->assertJsonMissingPath('data.events');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipments/{$sid}")->assertJsonPath('data.events.0.status', 'cancelled')
            ->assertJsonPath('data.can', ['cancel' => false, 'mark_cancelled' => false, 'refresh' => false]);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenant, $id)->status);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$sid}/mark-cancelled")->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")->assertJsonPath('data.shipment', null)->assertJsonCount(1, 'data.shipments');
        $this->book($h, $store, $id)->assertCreated(); // the order can be booked again
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$id}")->assertJsonPath('data.shipment.status', 'booked');
    }
}
