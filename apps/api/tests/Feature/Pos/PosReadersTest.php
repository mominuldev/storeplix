<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Automations\Engine\AutomationTriggers;
use App\Domain\FraudGuard\ShopRecord;
use App\Domain\Orders\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8D §8, P88D-13/14/22, S205: where till sales show and where they never do. Every reader of the walk-in
 * sentinels (`customer_phone` '', `shipping_address` {}, `district_code` '') is exercised with a walk-in till sale, and
 * a static test keeps the list of `district_code` / `shipping_address` readers closed.
 */
#[Group('pos')]
#[Group('security')]
class PosReadersTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    /** Every app file that reads or writes `district_code` / `shipping_address`, with why a till sale is safe there. */
    private const ADDRESS_READERS = [
        'app/Domain/Cart/Http/StorefrontCartController.php' => 'cart shipping quote (no orders)',
        'app/Domain/Couriers/AreaMapper.php' => 'courier areas (booking refuses delivered orders)',
        'app/Domain/Couriers/BookingService.php' => 'booking refuses delivered orders (till sales are delivered)',
        'app/Domain/Couriers/Http/Controllers/CourierAccountController.php' => 'courier settings (no orders)',
        'app/Domain/Couriers/Http/Controllers/ShipmentController.php' => 'shipments only (till sales have none)',
        'app/Domain/Couriers/Http/Requests/CourierAreasRequest.php' => 'courier settings (no orders)',
        'app/Domain/Couriers/Models/CourierAreaMapping.php' => 'courier settings (no orders)',
        'app/Domain/Couriers/ShipmentPresenter.php' => 'shipments only',
        'app/Domain/Documents/DocumentRenderer.php' => 'invoice / receipt print tolerates an empty address; labels refuse till sales',
        'app/Domain/Geo/AddressValidator.php' => 'input validation (no orders)',
        'app/Domain/Geo/BdGeo.php' => 'geo data',
        'app/Domain/Orders/Http/OrderController.php' => 'list filter + manual orders (district filter never matches \'\')',
        'app/Domain/Orders/Http/StorefrontOrderController.php' => 'storefront: tracking never finds a till sale',
        'app/Domain/Orders/Models/Order.php' => 'model',
        'app/Domain/Orders/OrderItemEditor.php' => 'item edits only on editable statuses (till sales are delivered)',
        'app/Domain/Orders/OrderPlacementService.php' => 'writes the sentinels for till sales (pos())',
        'app/Domain/Orders/OrderPresenter.php' => 'address() / district default to \'\'',
        'app/Domain/Orders/OrderService.php' => 'update() only on editable statuses',
        'app/Domain/Payments/Gateways/SslCommerzGateway.php' => 'online checkout only',
        'app/Domain/Reports/DeliveryReport.php' => 'shipments only (till sales have none)',
        'app/Domain/Reports/SalesReport.php' => 'district breakdown skips till sales',
        'app/Domain/Returns/ReturnService.php' => 'exchange orders refused for till sales',
        'app/Domain/Shipping/Http/ShippingController.php' => 'shipping settings (no orders)',
        'app/Domain/Shipping/Models/PickupLocation.php' => 'pickup addresses (no orders)',
        'app/Domain/Shipping/Models/ShippingZoneArea.php' => 'zones (no orders)',
        'app/Domain/Shipping/ShippingPresenter.php' => 'zones (no orders)',
        'app/Domain/Shipping/ShippingService.php' => 'zones (no orders)',
        'app/Domain/Shipping/ZoneResolver.php' => 'zones (no orders)',
        'app/Domain/Support/Admin/SupportOrderCard.php' => 'support order card (walk-in sales: no address, falls back to [])',
        'app/Domain/Tracking/TrackingPayloads.php' => 'tracking city hash: till sales are never tracked (P89D-11); {} district → omitted',
    ];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_every_district_code_and_shipping_address_reader_is_on_the_allow_list(): void
    {
        $found = [];
        $root = base_path('app');
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS));
        foreach ($files as $file) {
            if ($file->getExtension() !== 'php') {
                continue;
            }
            $code = (string) file_get_contents($file->getPathname());
            if (preg_match('/district_code|shipping_address/', $code) === 1) {
                $found[] = 'app'.str_replace('\\', '/', substr($file->getPathname(), strlen($root)));
            }
        }
        sort($found);
        $allowed = array_keys(self::ADDRESS_READERS);
        sort($allowed);
        $this->assertSame($allowed, $found, 'A new reader of district_code / shipping_address must be checked against walk-in till sales (S205) and listed here.');
    }

    public function test_orders_list_detail_filter_and_tag(): void
    {
        $s = $this->posShop(shopStock: 5, price: 20000);
        [$h, $store] = [$s['h'], $s['store']];
        $session = $this->posSession($s);
        $sale = $this->cashSale($s, $session);
        $online = $this->placeOrder($store, $s['variant'])->json('data.order.number');

        $list = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders")->assertOk()->json('data');
        $this->assertCount(2, $list);
        $till = collect($list)->firstWhere('id', $sale['order_id']);
        $this->assertSame(['sale_id' => $sale['id'], 'register_id' => $s['register'], 'register_name' => 'Register 1'], $till['pos']);
        $this->assertSame(['pos', 'walk_in', 'pos', 'delivered', 'paid', '', ''], [$till['created_via'], $till['channel'], $till['payment_method'], $till['status'], $till['payment_status'], $till['district'], $till['thana']]);
        $this->assertNull(collect($list)->firstWhere('number', $online)['pos']);

        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[created_via]=pos")->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $sale['order_id']);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[created_via]=storefront,dashboard")->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[created_via]=kiosk")->assertStatus(422);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders?filter[district_code]=dhaka")->assertOk()->assertJsonCount(1, 'data');

        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$sale['order_id']}")->assertOk()
            ->assertJsonPath('data.pos.register_name', 'Register 1')
            ->assertJsonPath('data.shipping_address.district_code', '')
            ->assertJsonPath('data.shipment', null)
            ->assertJsonPath('data.can.edit', false)
            ->assertJsonPath('data.allowed_transitions', fn ($t) => ! in_array('shipped', $t, true))
            ->assertJsonPath('data.payments.0.pos_session_id', $session)
            ->assertJsonPath('data.timestamps.delivered_at', fn ($v) => is_string($v));
    }

    public function test_sales_report_counts_till_sales_but_skips_them_in_the_district_breakdown(): void
    {
        $s = $this->posShop(shopStock: 5, onlineStock: 5, price: 20000);
        [$h, $store] = [$s['h'], $s['store']];
        $session = $this->posSession($s);
        $this->cashSale($s, $session, 2); // 40000 at the till
        $number = $this->placeOrder($store, $s['variant'])->json('data.order.number'); // 20000 + delivery, Dhaka
        $order = (string) $this->platformQuery(Order::class)->where('number', $number)->value('id');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order}/{$step}")->assertOk();
        }
        $onlineTotal = (int) $this->platformQuery(Order::class)->whereKey($order)->value('total_amount');
        Cache::flush();

        $r = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/reports/sales")->assertOk();
        $this->assertSame(40000 + $onlineTotal, $r->json('data.summary.sales_amount'));
        $this->assertSame(2, $r->json('data.summary.sold_orders_count'));
        $channels = collect($r->json('data.channels'))->keyBy('channel');
        $this->assertSame(40000, $channels['walk_in']['sales_amount']);
        $districts = $r->json('data.areas.districts');
        $this->assertSame(['dhaka'], array_column($districts, 'district_code')); // no '' district
        $this->assertSame($onlineTotal, $districts[0]['sales_amount']);
        $this->assertEqualsWithDelta(1.0, $districts[0]['share'], 0.0001);
        $this->assertEqualsWithDelta(1.0, $r->json('data.areas.inside_dhaka_share'), 0.0001);

        // Profit & loss: delivered by delivered_at, no delivery cost. Delivery report: shipments only.
        $profit = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/reports/profit")->assertOk();
        $this->assertSame(40000 + $onlineTotal, $profit->json('data.summary.revenue_amount'));
        $delivery = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/reports/delivery")->assertOk();
        $this->assertNotContains('', array_column((array) $delivery->json('data.districts'), 'district_code')); // shipments only; till sales have none
        $this->assertSame(0, $this->platformTable('shipments')->where('order_id', $this->platformQuery(Order::class)->where('created_via', 'pos')->value('id'))->count());
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/dashboard")->assertOk();
    }

    public function test_till_sales_never_reach_tracking_couriers_labels_guard_records_or_automations(): void
    {
        $s = $this->posShop(shopStock: 5, price: 20000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $session = $this->posSession($s);
        $walkIn = $this->cashSale($s, $session);
        $withPhone = $this->cashSale($s, $session, 1, ['customer' => ['phone' => '01711552211', 'name' => 'Farhana']]);

        // Storefront tracking: the right number + phone of a till sale is the same 404 as an unknown one.
        $this->sf($store, 'POST', '/orders/track', ['number' => $withPhone['number'], 'phone' => '01711552211'])->assertNotFound();
        $this->sf($store, 'POST', '/orders/track', ['number' => $walkIn['number'], 'phone' => '01711552211'])->assertNotFound();

        // Courier booking and manual shipping refuse a delivered till sale; labels refuse it; invoices / receipts don't.
        $booking = $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$walkIn['order_id']}/shipments", ['provider' => 'steadfast']);
        $this->assertContains($booking->status(), [409, 422], (string) $booking->getContent());
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$walkIn['order_id']}/ship")->assertStatus(409);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents", ['kind' => 'label_4x6', 'order_ids' => [$walkIn['order_id']]])
            ->assertStatus(422)->assertJsonValidationErrors(['order_ids.0'], 'error.details');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/documents", ['kind' => 'receipt_80mm', 'order_ids' => [$walkIn['order_id'], $withPhone['order_id']]])->assertStatus(202);

        // Exchange returns of a till sale are refused (no address to deliver to; return + new sale instead).
        $item = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$withPhone['order_id']}")->json('data.items.0.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$withPhone['order_id']}/returns", [
            'type' => 'exchange', 'reason' => 'wrong_size', 'lines' => [['order_item_id' => $item, 'quantity' => 1, 'exchange_variant_id' => $s['variant']]],
        ])->assertStatus(422)->assertJsonValidationErrors(['type'], 'error.details');

        // Fake-order guard: the phone's own-shop record ignores till sales; automations never see them.
        $this->inTenant($tenant, function () use ($store, $withPhone) {
            $record = ShopRecord::for($store->id, '01711552211');
            $this->assertSame([0, 0], [$record->delivered, $record->returned]);
            $this->assertTrue(AutomationTriggers::isTillSale('order', $withPhone['order_id']));
            $this->assertSame(0, AutomationTriggers::fire($store->id, 'order.delivered', 'order', $withPhone['order_id']));
        });
    }
}
