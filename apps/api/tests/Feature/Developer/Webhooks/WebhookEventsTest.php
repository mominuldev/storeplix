<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use App\Domain\Billing\Models\Plan;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Developer\Webhooks\Models\WebhookDelivery;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\ShipmentFixtures;
use Tests\TestCase;

/**
 * PHASE-8-4 §4.1: one test per event (fake sender), with the §4.2 envelope and the subject snapshot built by the
 * merchant presenters (P84-12); nothing recorded without a subscribed active endpoint, without api_webhooks (P84-13)
 * or when the transaction rolls back.
 */
#[Group('developer-api')]
class WebhookEventsTest extends TestCase
{
    use RefreshDatabase, ShipmentFixtures, WebhookFixtures;

    private const ALL = ['order.created', 'order.confirmed', 'order.cancelled', 'order.paid', 'shipment.updated', 'shipment.delivered',
        'return.received', 'product.updated', 'stock.low', 'customer.created'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWebhooks();
        config(['webhooks_out.fake' => true]);
    }

    /** @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string, 4: CourierAccount} tenant, store, h, variant, courier account */
    private function hookedShop(array $events = self::ALL): array
    {
        [, $tenant, $store, $h, $variant, $account] = $this->courierShop();
        $this->growth($tenant);
        $this->endpointId($h, $store, $events);

        return [$tenant, $store, $h, $variant, $account];
    }

    private function one(Tenant $tenant, string $type): WebhookDelivery
    {
        $rows = $this->deliveriesOf($tenant, $type);
        $this->assertCount(1, $rows, "expected exactly one {$type} delivery");
        $row = $rows->first();
        $this->assertSame('succeeded', $row->status);
        $this->assertSame($type, $row->payload['type']);
        $this->assertSame('2026-12-01', $row->payload['api_version']);
        $this->assertSame($row->event_id, $row->payload['id']);

        return $row;
    }

    public function test_order_created_from_dashboard_and_storefront(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $order = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data');
        $row = $this->one($tenant, 'order.created');
        $this->assertSame($order['number'], $row->subject_label);
        $this->assertSame('order', $row->subject_type);
        $this->assertSame($order['id'], $row->payload['data']['object']['id']);
        $this->assertSame('pending', $row->payload['data']['object']['status']);
        $this->assertSame($store->id, $row->payload['store_id']);
        $this->assertArrayHasKey('items', $row->payload['data']['object']);
        $this->assertNull($row->payload['data']['object']['items'][0]['cost_amount'] ?? null); // never costs

        $this->placeOrder($store, $variant);
        $this->assertCount(2, $this->deliveriesOf($tenant, 'order.created'));
    }

    public function test_order_confirmed(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $id = $this->confirmedOrder($h, $store, $variant);
        $row = $this->one($tenant, 'order.confirmed');
        $this->assertSame($id, $row->subject_id);
        $this->assertSame('confirmed', $row->payload['data']['object']['status']);
    }

    public function test_order_cancelled(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $id = $this->manual($h, $store, $this->manualBody($variant))->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/cancel", ['reason' => 'duplicate', 'notify_customer' => false])->assertOk();
        $this->assertSame('cancelled', $this->one($tenant, 'order.cancelled')->payload['data']['object']['status']);
        $this->assertCount(0, $this->deliveriesOf($tenant, 'order.confirmed'));
    }

    public function test_order_paid_and_shipment_events_on_manual_fulfilment(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $id = $this->confirmedOrder($h, $store, $variant);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/ship", ['carrier_name' => 'Sundarban', 'notify_customer' => false])->assertOk();
        $this->assertCount(1, $this->deliveriesOf($tenant, 'shipment.updated'));
        $this->assertCount(0, $this->deliveriesOf($tenant, 'order.paid'));

        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/deliver", ['notify_customer' => false])->assertOk();
        $paid = $this->one($tenant, 'order.paid');
        $this->assertSame('paid', $paid->payload['data']['object']['payment_status']);
        $this->assertCount(2, $this->deliveriesOf($tenant, 'shipment.updated'));
        $delivered = $this->one($tenant, 'shipment.delivered');
        $this->assertSame('shipment', $delivered->subject_type);
        $this->assertSame('delivered', $delivered->payload['data']['object']['status']);
        $this->assertSame($id, $delivered->payload['data']['object']['order']['id']);
    }

    public function test_shipment_updated_and_delivered_from_courier_events(): void
    {
        [$tenant, $store, $h, $variant, $account] = $this->hookedShop();
        $order = $this->confirmedOrder($h, $store, $variant);
        $shipment = $this->book($h, $store, $order)->assertCreated()->json('data.id');
        $this->assertSame('booked', $this->one($tenant, 'shipment.updated')->payload['data']['object']['status']);

        foreach (['in_transit', 'delivered'] as $status) {
            $this->courierSays($tenant, $shipment, $status);
            $payload = $this->inTenant($tenant, fn () => $this->fake()->webhookPayload(Shipment::query()->findOrFail($shipment)));
            $this->webhook($account, $payload)->assertOk();
        }
        $this->assertCount(3, $this->deliveriesOf($tenant, 'shipment.updated'));
        $delivered = $this->one($tenant, 'shipment.delivered');
        $this->assertSame($shipment, $delivered->subject_id);
        $orderNumber = $this->inTenant($tenant, fn () => Order::query()->whereKey($order)->value('number'));
        $this->assertSame($orderNumber, $delivered->subject_label);
        $this->assertCount(1, $this->deliveriesOf($tenant, 'order.paid')); // COD collected on delivery
    }

    public function test_return_received(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false])->assertOk();
        }
        $return = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'return', 'reason' => 'wrong_size',
            'lines' => [['order_item_id' => $order['items'][0]['id'], 'quantity' => 1]]])->assertCreated()->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/approve", [])->assertOk();
        $this->assertCount(0, $this->deliveriesOf($tenant, 'return.received'));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/returns/{$return['id']}/receive", ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true],
            'lines' => [['return_item_id' => $return['items'][0]['id'], 'restock_quantity' => 1]]])->assertOk();
        $row = $this->one($tenant, 'return.received');
        $this->assertSame('return_request', $row->subject_type);
        $this->assertSame($return['number'], $row->subject_label);
        $this->assertSame('received', $row->payload['data']['object']['status']);
    }

    public function test_product_updated_on_create_and_update(): void
    {
        [$tenant, $store, $h] = $this->hookedShop();
        $before = $this->deliveriesOf($tenant, 'product.updated')->count();
        $product = $this->createProduct($h, $store, $this->simpleProduct('Webhook Panjabi', 120000, [], ['cost_amount' => 50000]));
        $rows = $this->deliveriesOf($tenant, 'product.updated');
        $this->assertCount($before + 1, $rows);
        $row = $rows->last();
        $this->assertSame('Webhook Panjabi', $row->subject_label);
        $this->assertSame($product['id'], $row->payload['data']['object']['id']);
        $this->assertNull($row->payload['data']['object']['variants'][0]['cost_amount']); // costs never leave

        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$product['id']}", ['name' => 'Renamed', 'revision' => $product['revision']])->assertOk();
        $this->assertSame('Renamed', $this->deliveriesOf($tenant, 'product.updated')->last()->payload['data']['object']['name']);
    }

    public function test_stock_low_once_per_crossing(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop(); // 20 on hand, default threshold 5
        $adjust = fn (int $qty) => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments",
            ['reason' => 'lost', 'items' => [['variant_id' => $variant, 'mode' => 'set', 'quantity' => $qty]]])->assertOk();

        $adjust(6);
        $this->assertCount(0, $this->deliveriesOf($tenant, 'stock.low'));
        $adjust(5); // 6 → 5: crosses
        $row = $this->one($tenant, 'stock.low');
        $this->assertSame('inventory', $row->subject_type);
        $this->assertSame($variant, $row->payload['data']['object']['variant_id']);
        $this->assertSame(5, $row->payload['data']['object']['on_hand']);
        $adjust(2); // still below: no new event
        $this->assertCount(1, $this->deliveriesOf($tenant, 'stock.low'));
        $adjust(10);
        $adjust(4); // crosses again
        $this->assertCount(2, $this->deliveriesOf($tenant, 'stock.low'));
    }

    public function test_stock_low_when_shipping_an_order(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments",
            ['reason' => 'lost', 'items' => [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 7]]])->assertOk();
        $id = $this->confirmedOrder($h, $store, $variant, 3);
        $this->assertCount(0, $this->deliveriesOf($tenant, 'stock.low'));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$id}/ship", ['notify_customer' => false])->assertOk(); // 7 → 4
        $this->assertCount(1, $this->deliveriesOf($tenant, 'stock.low'));
    }

    public function test_customer_created_from_dashboard_and_checkout(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop();
        $customer = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'Webhook Customer', 'phone' => '01712345678'])->assertCreated()->json('data');
        $row = $this->one($tenant, 'customer.created');
        $this->assertSame($customer['id'], $row->subject_id);
        $this->assertSame('Webhook Customer', $row->subject_label);
        $this->assertStringEndsWith('1712345678', (string) $row->payload['data']['object']['phone']);

        $this->placeOrder($store, $variant); // new phone → new customer
        $this->assertCount(2, $this->deliveriesOf($tenant, 'customer.created'));
        $this->placeOrder($store, $variant); // same phone → existing customer
        $this->assertCount(2, $this->deliveriesOf($tenant, 'customer.created'));
    }

    public function test_nothing_is_recorded_without_a_subscription_the_plan_or_a_commit(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop(['order.paid']);
        $this->manual($h, $store, $this->manualBody($variant))->assertCreated();
        $this->assertCount(0, $this->deliveriesOf($tenant)); // not subscribed

        $this->api($h, 'POST', $this->hookUrl($store), ['url' => self::HOOK.'/2', 'events' => ['order.created']])->assertCreated();
        $this->planFor($tenant, Plan::FREE);
        $this->manual($h, $store, $this->manualBody($variant))->assertCreated();
        $this->assertCount(0, $this->deliveriesOf($tenant)); // P84-13: dropped, not queued

        $this->growth($tenant);
        $this->inTenant($tenant, function () use ($store) {
            try {
                DB::transaction(function () use ($store) {
                    WebhookEvents::emit(WebhookEventType::OrderCreated, Order::query()->where('store_id', $store->id)->firstOrFail());
                    throw new RuntimeException('rollback');
                });
            } catch (RuntimeException) {
            }
        });
        $this->assertCount(0, $this->deliveriesOf($tenant)); // rolled back: never sent

        $this->manual($h, $store, $this->manualBody($variant))->assertCreated();
        $this->assertCount(1, $this->deliveriesOf($tenant, 'order.created'));
    }

    public function test_disabled_endpoints_get_nothing(): void
    {
        [$tenant, $store, $h, $variant] = $this->hookedShop(['order.created']);
        $id = $this->api($h, 'GET', $this->hookUrl($store))->json('data.0.id');
        $this->api($h, 'PATCH', $this->hookUrl($store, "/{$id}"), ['is_active' => false])->assertOk();
        $this->manual($h, $store, $this->manualBody($variant))->assertCreated();
        $this->assertCount(0, $this->deliveriesOf($tenant));
    }
}
