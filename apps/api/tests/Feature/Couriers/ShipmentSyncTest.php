<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\PathaoCourier;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Couriers\Models\ShipmentEvent;
use App\Domain\Couriers\ShipmentSync;
use App\Domain\Customers\Models\Customer;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/** PHASE-5B P5B-36…P5B-38, §6.4, §8: webhooks (auth, dedupe, S32), order effects, polling, fake-advance tools. */
#[Group('couriers')]
class ShipmentSyncTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    /** @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string, 4: string, 5: CourierAccount, 6: string} tenant, store, h, order, shipment, account, variant */
    private function booked(string $provider = 'steadfast', int $quantity = 2): array
    {
        [, $tenant, $store, $h, $variant, $account] = $this->courierShop($provider);
        $order = $this->confirmedOrder($h, $store, $variant, $quantity);
        $body = $provider === 'steadfast' ? [] : ['area' => ['city_id' => '1', 'zone_id' => '11', 'area_id' => '1001']];
        $shipment = $this->book($h, $store, $order, ['provider' => $provider] + $body)->assertCreated()->json('data.id');

        return [$tenant, $store, $h, $order, $shipment, $account, $variant];
    }

    private function payload(Tenant $tenant, string $shipmentId, ?string $status = null): array
    {
        return $this->inTenant($tenant, fn () => $this->fake(Shipment::query()->findOrFail($shipmentId)->provider)->webhookPayload(Shipment::query()->findOrFail($shipmentId), $status));
    }

    /** Courier moves the parcel, then sends the matching signed webhook. */
    private function push(Tenant $tenant, CourierAccount $account, string $shipmentId, string $status, ?int $cod = null, ?string $at = null): void
    {
        $this->courierSays($tenant, $shipmentId, $status, $cod, $at);
        $this->webhook($account, $this->payload($tenant, $shipmentId))->assertStatus($account->provider === 'pathao' ? 202 : 200)
            ->assertExactJson(['data' => ['received' => true]]);
    }

    private function at(int $minutes): string
    {
        return now()->addMinutes($minutes)->startOfSecond()->toIso8601ZuluString();
    }

    private function onHand(Tenant $tenant, string $variant): int
    {
        return $this->inTenant($tenant, fn () => (int) Inventory::query()->where('variant_id', $variant)->value('on_hand'));
    }

    #[Group('security')]
    public function test_webhook_auth_and_dedupe(): void
    {
        [$tenant, , , , $shipment, $account] = $this->booked();
        $payload = $this->payload($tenant, $shipment, 'picked_up');
        $this->webhook($account, $payload, 'wrong-secret')->assertStatus(401);
        $this->webhook($account, $payload, null)->assertStatus(401);
        $this->assertSame(0, $this->inTenant($tenant, fn () => WebhookEvent::query()->count())); // nothing stored
        $this->flushHeaders()->postJson('/api/v1/webhooks/steadfast/'.str_repeat('A', 32), $payload)->assertNotFound();
        $this->flushHeaders()->postJson("/api/v1/webhooks/pathao/{$account->route_key}", $payload)->assertNotFound(); // other provider's key

        $this->courierSays($tenant, $shipment, 'picked_up');
        $payload = $this->payload($tenant, $shipment);
        $this->webhook($account, $payload)->assertOk();
        $this->webhook($account, $payload)->assertOk(); // duplicate event id → no effect
        $this->inTenant($tenant, function () use ($shipment) {
            $this->assertSame(1, WebhookEvent::query()->count());
            $this->assertSame('processed', WebhookEvent::query()->value('status'));
            $this->assertSame(['booked', 'picked_up'], ShipmentEvent::query()->where('shipment_id', $shipment)->orderBy('occurred_at')->orderBy('created_at')->pluck('status')->all());
            $this->assertNotNull(CourierAccount::query()->value('last_webhook_at'));
            // S26: the stored payload carries no secret and no recipient data
            $this->assertStringNotContainsString(self::WEBHOOK_SECRET, json_encode(WebhookEvent::query()->value('payload')));
        });
    }

    public function test_pathao_answers_202_and_acknowledges_the_integration_test_event(): void
    {
        [$tenant, , , $order, $shipment, $account] = $this->booked('pathao');
        $ack = $this->webhook($account, ['event' => 'webhook_integration'])->assertStatus(202);
        foreach (PathaoCourier::WEBHOOK_RESPONSE_HEADERS as $name => $value) {
            $ack->assertHeader($name, $value);
        }
        $this->webhook($account, ['event' => 'webhook_integration'], 'wrong')->assertStatus(401);
        $this->assertSame(0, $this->inTenant($tenant, fn () => WebhookEvent::query()->count()));
        $this->push($tenant, $account, $shipment, 'picked_up');
        $this->assertSame('shipped', $this->orderRow2($tenant, $order)->status);
    }

    public function test_redx_has_no_webhook_endpoint_until_verified(): void
    {
        [$tenant, , , , , $account] = $this->booked('redx');
        $this->flushHeaders()->postJson("/api/v1/webhooks/redx/{$account->route_key}", ['status' => 'delivered'])->assertNotFound();
        $this->assertSame(0, $this->inTenant($tenant, fn () => WebhookEvent::query()->count()));
    }

    public function test_pickup_ships_the_order_once_and_moves_stock(): void
    {
        [$tenant, , $h, $order, $shipment, $account, $variant] = $this->booked();
        $before = $this->onHand($tenant, $variant);
        $this->push($tenant, $account, $shipment, 'picked_up', at: $this->at(10));
        $this->push($tenant, $account, $shipment, 'in_transit', at: $this->at(20));
        $o = $this->orderRow2($tenant, $order);
        $this->assertSame('shipped', $o->status);
        $this->assertNotNull($o->shipped_at);
        $this->assertSame($before - 2, $this->onHand($tenant, $variant));
        $this->inTenant($tenant, function () use ($order) {
            $this->assertSame(1, InventoryMovement::query()->where('reference_id', $order)->where('reason', 'order_shipped')->count());
        });
        $s = $this->shipmentRow($tenant, $shipment);
        $this->assertSame(['in_transit', 'in_transit'], [$s->status, $s->provider_status]);
        $this->assertNotNull($s->picked_up_at);
        // Replay of an older event never moves anything backwards.
        $this->push($tenant, $account, $shipment, 'picked_up', at: $this->at(-60));
        $this->assertSame('in_transit', $this->shipmentRow($tenant, $shipment)->status);
        $this->assertSame($before - 2, $this->onHand($tenant, $variant));
    }

    public function test_delivered_collects_cod_and_updates_counters(): void
    {
        [$tenant, $store, $h, $order, $shipment, $account] = $this->booked();
        $due = $this->orderRow2($tenant, $order)->dueAmount();
        // Delivered straight from booked (pickup signal missed): shipped first, then delivered.
        $this->push($tenant, $account, $shipment, 'delivered');
        $o = $this->orderRow2($tenant, $order);
        $this->assertSame(['delivered', $o->total_amount, 'paid'], [$o->status, $o->paid_amount, $o->payment_status]);
        $this->inTenant($tenant, function () use ($order, $due, $o) {
            $charge = Payment::query()->where('order_id', $order)->where('provider', 'cod')->firstOrFail();
            $this->assertSame(['succeeded', $due], [$charge->status, $charge->amount]);
            $this->assertSame(1, Customer::query()->whereKey($o->customer_id)->value('delivered_orders_count'));
        });
        $s = $this->shipmentRow($tenant, $shipment);
        $this->assertSame([$due, 'delivered'], [$s->cod_collected_amount, $s->status]);
        $this->assertNotNull($s->delivered_at);
        // Finals are final: a late in_transit changes nothing.
        $this->push($tenant, $account, $shipment, 'in_transit');
        $this->assertSame('delivered', $this->shipmentRow($tenant, $shipment)->status);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipments/{$shipment}")->assertOk()
            ->assertJsonPath('data.money.collect_amount', $due)->assertJsonPath('data.money.net_amount', $due - FakeCourier::DELIVERY_FEE)
            ->assertJsonPath('data.can.refresh', false);
    }

    public function test_partially_delivered_creates_a_courier_return(): void
    {
        [$tenant, , , $order, $shipment, $account] = $this->booked();
        $this->push($tenant, $account, $shipment, 'out_for_delivery');
        $this->push($tenant, $account, $shipment, 'partially_delivered', 50000);
        $o = $this->orderRow2($tenant, $order);
        $this->assertSame(['delivered', 50000, 'partially_paid', 'requested'], [$o->status, $o->paid_amount, $o->payment_status, $o->return_status]);
        $this->inTenant($tenant, function () use ($order) {
            $r = ReturnRequest::query()->where('order_id', $order)->firstOrFail();
            $this->assertSame(['courier', 'requested', 'return'], [$r->source, $r->status, $r->type]);
            $this->assertSame(['succeeded', 50000], [Payment::query()->where('order_id', $order)->where('provider', 'cod')->value('status'), (int) Payment::query()->where('order_id', $order)->where('provider', 'cod')->value('amount')]);
        });
    }

    public function test_returned_marks_the_order_returned_without_restock(): void
    {
        [$tenant, , , $order, $shipment, $account, $variant] = $this->booked();
        $this->push($tenant, $account, $shipment, 'in_transit');
        $afterShip = $this->onHand($tenant, $variant);
        $this->push($tenant, $account, $shipment, 'returning');
        $this->assertSame('returning', $this->shipmentRow($tenant, $shipment)->problem);
        $this->assertSame('shipped', $this->orderRow2($tenant, $order)->status);
        $this->push($tenant, $account, $shipment, 'returned');
        $o = $this->orderRow2($tenant, $order);
        $this->assertSame(['returned', 0], [$o->status, $o->paid_amount]);
        $this->assertSame($afterShip, $this->onHand($tenant, $variant)); // P5B-36: no automatic restock
        $this->inTenant($tenant, fn () => $this->assertSame('cancelled', Payment::query()->where('order_id', $order)->where('provider', 'cod')->value('status')));
        $s = $this->shipmentRow($tenant, $shipment);
        $this->assertSame(['returned', null], [$s->status, $s->problem]);
    }

    public function test_cancelled_before_pickup_frees_the_order(): void
    {
        [$tenant, $store, $h, $order, $shipment, $account] = $this->booked();
        $this->push($tenant, $account, $shipment, 'cancelled');
        $this->assertSame('cancelled', $this->shipmentRow($tenant, $shipment)->status);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenant, $order)->status);
        $this->book($h, $store, $order)->assertCreated();
    }

    public function test_problems_and_unknown_words(): void
    {
        [$tenant, , , , $shipment, $account] = $this->booked();
        $this->push($tenant, $account, $shipment, 'in_transit', at: $this->at(10));
        $this->push($tenant, $account, $shipment, 'delivery_failed', at: $this->at(20));
        $this->assertSame(['delivery_failed', 'delivery_failed'], [$this->shipmentRow($tenant, $shipment)->status, $this->shipmentRow($tenant, $shipment)->problem]);
        $this->push($tenant, $account, $shipment, 'out_for_delivery', at: $this->at(30));
        $this->assertSame(['out_for_delivery', null], [$this->shipmentRow($tenant, $shipment)->status, $this->shipmentRow($tenant, $shipment)->problem]);
        // An unknown courier word keeps the status and flags the parcel.
        $this->webhook($account, ['consignment_id' => $this->shipmentRow($tenant, $shipment)->consignment_id, 'status' => 'lost_in_space', 'occurred_at' => $this->at(40)])->assertOk();
        $s = $this->shipmentRow($tenant, $shipment);
        $this->assertSame(['out_for_delivery', 'unknown', 'lost_in_space'], [$s->status, $s->problem, $s->provider_status]);
        $this->inTenant($tenant, fn () => $this->assertSame('Courier problem · needs you', ShipmentEvent::query()->where('provider_status', 'lost_in_space')->value('description')));
    }

    #[Group('security')]
    public function test_s32_money_statuses_are_requeried_and_consignments_are_looked_up_within_the_tenant(): void
    {
        [$tenant, , , $order, $shipment, $account] = $this->booked();
        // Forged "delivered" while the courier API says the parcel is still booked → nothing changes.
        $this->webhook($account, $this->payload($tenant, $shipment, 'delivered') + ['cod_collected_amount' => 1])->assertOk();
        $this->assertSame('booked', $this->shipmentRow($tenant, $shipment)->status);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenant, $order)->status);

        // Store B's consignment on A's route key → ignored.
        [, $tenantB, $storeB, $hB, $variantB] = $this->courierShop('steadfast', 'other');
        $orderB = $this->confirmedOrder($hB, $storeB, $variantB);
        $shipmentB = $this->book($hB, $storeB, $orderB)->assertCreated()->json('data.id');
        $this->courierSays($tenantB, $shipmentB, 'delivered');
        $this->webhook($account, $this->payload($tenantB, $shipmentB))->assertOk();
        $this->assertSame('booked', $this->shipmentRow($tenantB, $shipmentB)->status);
        $this->assertSame('ready_to_ship', $this->orderRow2($tenantB, $orderB)->status);
        $this->inTenant($tenant, fn () => $this->assertSame(['processed', 'ignored:unknown_shipment'],
            WebhookEvent::query()->orderBy('received_at')->orderBy('id')->get()->map(fn ($e) => $e->status.($e->error_code ? ':'.$e->error_code : ''))->all()));
        $this->assertSame(0, $this->inTenant($tenantB, fn () => WebhookEvent::query()->count()));
    }

    public function test_poll_job_syncs_stale_shipments_and_records_last_sync(): void
    {
        [$tenant, , , $order, $shipment, $account] = $this->booked();
        $this->courierSays($tenant, $shipment, 'in_transit');
        $this->artisan('couriers:sync', ['--sync' => true])->assertSuccessful();
        $this->assertSame('in_transit', $this->shipmentRow($tenant, $shipment)->status);
        $this->assertSame('shipped', $this->orderRow2($tenant, $order)->status);
        $this->assertNotNull($this->inTenant($tenant, fn () => CourierAccount::query()->value('last_synced_at')));
        // Synced < 15 min ago: skipped by the next poll; 15 min later it is polled again.
        $this->courierSays($tenant, $shipment, 'delivered');
        $this->artisan('couriers:sync', ['--sync' => true]);
        $this->assertSame('in_transit', $this->shipmentRow($tenant, $shipment)->status);
        $this->travel(16)->minutes();
        $this->artisan('couriers:sync', ['--sync' => true]);
        $this->assertSame('delivered', $this->shipmentRow($tenant, $shipment)->status);
        $this->assertSame('delivered', $this->orderRow2($tenant, $order)->status);
    }

    public function test_refresh_sync_now_and_their_throttles(): void
    {
        [$tenant, $store, $h, , $shipment] = $this->booked();
        $this->courierSays($tenant, $shipment, 'picked_up');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$shipment}/refresh")->assertOk()
            ->assertJsonPath('data.status', 'picked_up')->assertJsonPath('data.events.0.status', 'picked_up')->assertJsonPath('data.events.0.source', 'user');
        for ($i = 0; $i < 5; $i++) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$shipment}/refresh")->assertOk();
        }
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/{$shipment}/refresh")->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        $this->courierSays($tenant, $shipment, 'in_transit');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/sync")->assertStatus(202)->assertJsonPath('data.queued', 1);
        $this->assertSame('in_transit', $this->shipmentRow($tenant, $shipment)->status);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/shipments/sync")->assertStatus(429);
    }

    public function test_fake_advance_endpoint_and_command(): void
    {
        [$tenant, , , $order, $shipment] = $this->booked();
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$shipment}/advance", ['status' => 'teleported'])->assertStatus(422);
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$shipment}/advance", ['status' => 'picked_up'])->assertOk()
            ->assertJsonPath('data.status', 'picked_up')->assertJsonPath('data.order_status', 'shipped');
        $this->inTenant($tenant, fn () => $this->assertSame(1, WebhookEvent::query()->where('status', 'processed')->count())); // webhook path
        $this->artisan('couriers:fake-advance', ['shipment' => $shipment, 'status' => 'delivered'])->assertSuccessful();
        $this->assertSame('delivered', $this->orderRow2($tenant, $order)->status);

        config(['couriers.fake' => false]);
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$shipment}/advance", ['status' => 'returned'])->assertNotFound();
    }

    #[Group('security')]
    public function test_storefront_tracking_shows_courier_status_and_times_only(): void
    {
        [$tenant, $store, , $order, $shipment] = $this->booked();
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$shipment}/advance", ['status' => 'out_for_delivery'])->assertOk();
        $number = $this->orderRow2($tenant, $order)->number;
        $r = $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01811223344'])->assertOk()
            ->assertJsonPath('data.shipment.status', 'out_for_delivery')
            ->assertJsonPath('data.shipment.events.0.status', 'out_for_delivery')
            ->assertJsonPath('data.shipment.events.1.status', 'booked');
        $tracking = $r->json('data.shipment');
        $this->assertSame(['carrier_name', 'tracking_code', 'tracking_url', 'status', 'status_at', 'checked_at', 'events'], array_keys($tracking));
        $this->assertNotNull($tracking['status_at']);
        $this->assertNotNull($tracking['checked_at']); // delivered by webhook
        foreach ($tracking['events'] as $event) {
            $this->assertSame(['status', 'at'], array_keys($event)); // never description / location / provider_status
        }
        $json = json_encode($r->json());
        foreach (['description', 'location', 'provider_status', 'Out for delivery'] as $leak) {
            $this->assertStringNotContainsString($leak, $json);
        }
    }

    public function test_redx_fake_advance_goes_through_a_poll(): void
    {
        [$tenant, , , $order, $shipment] = $this->booked('redx');
        $this->flushHeaders()->postJson("/api/v1/dev/shipments/{$shipment}/advance", ['status' => 'in_transit'])->assertOk()
            ->assertJsonPath('data.status', 'in_transit')->assertJsonPath('data.order_status', 'shipped');
        $this->inTenant($tenant, fn () => $this->assertSame('poll', ShipmentEvent::query()->where('status', 'in_transit')->value('source')));
    }

    /** @return array<string, array{0: string, 1: string, 2: bool}> */
    public static function moves(): array
    {
        return [
            'booking → booked' => ['booking', 'booked', true],
            'booked → picked_up' => ['booked', 'picked_up', true],
            'booked → cancelled' => ['booked', 'cancelled', true],
            'picked_up → cancelled' => ['picked_up', 'cancelled', false],
            'in_transit → booked' => ['in_transit', 'booked', false],
            'in_transit → picked_up' => ['in_transit', 'picked_up', false],
            'in_transit → out_for_delivery' => ['in_transit', 'out_for_delivery', true],
            'delivery_failed → in_transit (newer)' => ['delivery_failed', 'in_transit', true],
            'returning → in_transit' => ['returning', 'in_transit', false],
            'returning → returned' => ['returning', 'returned', true],
            'delivered → returned' => ['delivered', 'returned', false],
            'returned → delivered' => ['returned', 'delivered', false],
            'cancelled → picked_up' => ['cancelled', 'picked_up', false],
            'booking_failed → booked' => ['booking_failed', 'booked', false],
        ];
    }

    #[DataProvider('moves')]
    public function test_status_moves_are_monotonic(string $from, string $to, bool $allowed): void
    {
        $this->assertSame($allowed, ShipmentSync::canMove($from, $to));
    }

    public function test_out_of_order_lateral_event_is_recorded_but_not_applied(): void
    {
        $this->assertFalse(ShipmentSync::canMove('out_for_delivery', 'in_transit', false));
        $this->assertTrue(ShipmentSync::canMove('out_for_delivery', 'in_transit', true));
    }
}
