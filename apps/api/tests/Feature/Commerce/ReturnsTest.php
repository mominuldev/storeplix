<?php

namespace Tests\Feature\Commerce;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Returns\Models\ReturnEvent;
use App\Domain\Returns\Models\ReturnItem;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Returns\ReturnStateMachine;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-5B §4.9 / §8 / §13: returns & exchanges (P5B-63..P5B-70). */
class ReturnsTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    /**
     * Delivered order: A 2 × ৳10 + B 3 × ৳20 (coupon-free), with a 1-paisa-odd discount to exercise floor().
     *
     * @return array{tenant: Tenant, store: Store, h: array<string, string>, a: string, b: string, order: array<string, mixed>}
     */
    private function delivered(string $slug = 'shop'): array
    {
        [, $tenant, $store, $h] = $this->liveShop($slug);
        [, $a] = $this->stocked($h, $store, 1000, 10);
        [, $b] = $this->stocked($h, $store, 2000, 10);
        $body = $this->manualBody($a, 2, ['notify_customer' => false]);
        $body['items'][] = ['variant_id' => $b, 'quantity' => 3];
        $order = $this->manual($h, $store, $body)->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $order = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false])->assertOk()->json('data');
        }

        return compact('tenant', 'store', 'h', 'a', 'b', 'order');
    }

    private function r(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/returns{$suffix}";
    }

    public function test_create_bounds_numbering_and_amounts(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order, 'tenant' => $tenant] = $this->delivered();
        [$ia, $ib] = $order['items'];
        $create = fn (array $lines, string $type = 'return') => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => $type, 'reason' => 'wrong_size', 'lines' => $lines]);

        // odd line total → floor(total × qty / line qty)
        $this->inTenant($tenant, fn () => OrderItem::query()->whereKey($ib['id'])->update(['discount_amount' => 1, 'total_amount' => 5999]));
        $first = $create([['order_item_id' => $ib['id'], 'quantity' => 2]])->assertCreated()
            ->assertJsonPath('data.number', 'RT-0001')->assertJsonPath('data.status', 'requested')->assertJsonPath('data.source', 'merchant')
            ->assertJsonPath('data.requested_amount', 3999)->assertJsonPath('data.items.0.amount', 3999)
            ->assertJsonPath('data.allowed_transitions', ['approved', 'rejected'])->assertJsonPath('data.events.0.type', 'created')
            ->assertJsonPath('data.order.number', $order['number'])->json('data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.return_status', 'requested')->assertJsonPath('data.status', 'delivered');

        // only 1 of B left; A untouched (2)
        $create([['order_item_id' => $ib['id'], 'quantity' => 2]])->assertStatus(409)->assertJsonPath('error.code', 'return_not_allowed')
            ->assertJsonPath('error.details', ['lines.0.quantity' => ['Only 1 of this item can still be returned.']]);
        $create([['order_item_id' => $ib['id'], 'quantity' => 1], ['order_item_id' => $ia['id'], 'quantity' => 2]])->assertCreated()->assertJsonPath('data.number', 'RT-0002');
        $create([['order_item_id' => $ia['id'], 'quantity' => 1]])->assertStatus(409);
        // a rejected return frees its quantities again
        $this->api($h, 'POST', $this->r($store, "/{$first['id']}/reject"), ['reason' => 'Worn'])->assertOk()->assertJsonPath('data.status', 'rejected')->assertJsonPath('data.allowed_transitions', []);
        $create([['order_item_id' => $ib['id'], 'quantity' => 2]])->assertCreated()->assertJsonPath('data.number', 'RT-0003');

        // validation: unknown item, exchange without a variant; non-delivered order → 409
        $create([['order_item_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'quantity' => 1]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['lines.0.order_item_id']]]);
        $create([['order_item_id' => $ia['id'], 'quantity' => 1]], 'exchange')->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['lines.0.exchange_variant_id']]]);
        [, $v] = $this->stocked($h, $store, 1000, 5);
        $pending = $this->manual($h, $store, $this->manualBody($v))->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$pending['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $pending['items'][0]['id'], 'quantity' => 1]]])
            ->assertStatus(409)->assertJsonPath('error.code', 'return_not_allowed');
    }

    #[Group('security')]
    public function test_lifecycle_receive_restocks_and_refund_links_to_the_return(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order, 'tenant' => $tenant, 'a' => $a, 'b' => $b] = $this->delivered();
        [$ia, $ib] = $order['items'];
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $ret = $this->api($staff, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'return', 'reason' => 'damaged', 'customer_note' => 'Torn seam',
            'lines' => [['order_item_id' => $ia['id'], 'quantity' => 2], ['order_item_id' => $ib['id'], 'quantity' => 1]]])->assertCreated()->json('data');
        $this->assertSame(4000, $ret['requested_amount']);
        $id = $ret['id'];

        $this->api($staff, 'POST', $this->r($store, "/{$id}/receive"), ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true], 'lines' => [['return_item_id' => $ret['items'][0]['id'], 'restock_quantity' => 1]]])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($staff, 'POST', $this->r($store, "/{$id}/approve"), ['pickup_tracking_code' => 'RTN-77', 'note' => 'Courier picks up Monday'])->assertOk()
            ->assertJsonPath('data.status', 'approved')->assertJsonPath('data.pickup_tracking_code', 'RTN-77')->assertJsonPath('data.allowed_transitions', ['received', 'closed']);
        // restock more than returned → 422
        $this->api($staff, 'POST', $this->r($store, "/{$id}/receive"), ['checks' => ['tags_intact' => true, 'unused' => false, 'original_packaging' => true], 'lines' => [['return_item_id' => $ret['items'][1]['id'], 'restock_quantity' => 2]]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['lines.0.restock_quantity']]]);
        $this->api($staff, 'POST', $this->r($store, "/{$id}/receive"), ['checks' => ['tags_intact' => true, 'unused' => false, 'original_packaging' => true], 'lines' => [
            ['return_item_id' => $ret['items'][0]['id'], 'restock_quantity' => 2], ['return_item_id' => $ret['items'][1]['id'], 'restock_quantity' => 0],
        ]])->assertOk()->assertJsonPath('data.status', 'received')->assertJsonPath('data.checks', ['tags_intact' => true, 'unused' => false, 'original_packaging' => true])
            ->assertJsonPath('data.items.0.restocked_quantity', 2)->assertJsonPath('data.events.0.type', 'restock');

        $this->inTenant($tenant, function () use ($a, $b, $id) {
            $this->assertSame(10, Inventory::query()->where('variant_id', $a)->value('on_hand'));
            $this->assertSame(7, Inventory::query()->where('variant_id', $b)->value('on_hand'));
            $m = InventoryMovement::query()->where('reason', 'order_returned')->sole();
            $this->assertSame(['return', $id, 2], [$m->reference_type, $m->reference_id, $m->delta]);
        });
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.return_status', 'partially_returned')
            ->assertJsonPath('data.customer.returned_orders_count', 1)->assertJsonPath('data.items.0.restocked_quantity', 2);

        // refunds: staff 403; over the return → 422; partial; full → refunded (S30)
        $refund = fn (array $hh, int $amount) => $this->api($hh + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/refunds", ['amount' => $amount, 'method' => 'bkash_personal', 'return_id' => $id]);
        $refund($staff, 1000)->assertForbidden();
        $refund($h, 4001)->assertStatus(422)->assertJsonPath('error.code', 'refund_exceeds_paid');
        $refund($h, 1500)->assertCreated()->assertJsonPath('data.return_request_id', $id);
        $this->api($h, 'GET', $this->r($store, "/{$id}"))->assertJsonPath('data.refunded_amount', 1500)->assertJsonPath('data.status', 'received');
        $refund($h, 2500)->assertCreated();
        $this->api($h, 'GET', $this->r($store, "/{$id}"))->assertJsonPath('data.status', 'refunded')->assertJsonPath('data.refunded_amount', 4000)->assertJsonPath('data.allowed_transitions', []);
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/refunds", ['amount' => 1, 'method' => 'cash', 'return_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz'])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['return_id']]]);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.refunded_amount', 4000);
    }

    public function test_close_and_notes_and_state_machine_matrix(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order] = $this->delivered();
        $mk = fn () => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $order['items'][1]['id'], 'quantity' => 1]]])->json('data.id');
        $id = $mk();
        $this->api($h, 'POST', $this->r($store, "/{$id}/close"))->assertStatus(409);
        $this->api($h, 'POST', $this->r($store, "/{$id}/approve"))->assertOk();
        $this->api($h, 'POST', $this->r($store, "/{$id}/reject"), ['reason' => 'x'])->assertStatus(409);
        $this->api($h, 'POST', $this->r($store, "/{$id}/close"), ['note' => 'Customer kept it'])->assertOk()->assertJsonPath('data.status', 'closed');
        $this->api($h, 'POST', $this->r($store, "/{$id}/notes"), ['body' => 'Called again'])->assertCreated()->assertJsonPath('data.type', 'note');
        $this->api($h, 'POST', $this->r($store, "/{$id}/notes"), ['body' => ''])->assertStatus(422);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertJsonPath('data.return_status', 'none');

        foreach (ReturnStateMachine::TRANSITIONS as $from => $tos) {
            foreach (ReturnRequest::STATUSES as $to) {
                $this->assertSame(in_array($to, $tos, true), ReturnStateMachine::can($from, $to), "{$from} → {$to}");
            }
        }
    }

    public function test_exchange_creates_a_new_order_with_credit(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order, 'tenant' => $tenant, 'b' => $b] = $this->delivered();
        [, $big] = $this->stocked($h, $store, 3000, 5);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $ret = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'exchange', 'reason' => 'wrong_size',
            'lines' => [['order_item_id' => $order['items'][0]['id'], 'quantity' => 1, 'exchange_variant_id' => $big]]])->assertCreated()
            ->assertJsonPath('data.items.0.exchange_variant.price_amount', 3000)->assertJsonPath('data.items.0.exchange_variant.available', 5)
            ->assertJsonPath('data.price_difference_amount', 2000)->json('data');
        $id = $ret['id'];
        $exchange = fn (array $hh, array $body = [], ?string $key = null) => $this->api($hh + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->r($store, "/{$id}/exchange-order"), $body);
        $exchange($h)->assertStatus(409); // not received yet
        $this->api($h, 'POST', $this->r($store, "/{$id}/approve"))->assertOk();
        $this->api($h, 'POST', $this->r($store, "/{$id}/receive"), ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true], 'lines' => [['return_item_id' => $ret['items'][0]['id'], 'restock_quantity' => 1]]])
            ->assertOk()->assertJsonPath('data.allowed_transitions', ['refunded', 'exchanged', 'closed']);

        // 5b-2 seam: a payment link needs a connected gateway
        $exchange($h, ['send_payment_link' => ['provider' => 'bkash', 'expires_in_minutes' => 120]])->assertStatus(422)->assertJsonPath('error.code', 'gateway_not_connected');
        $key = (string) Str::uuid();
        $res = $exchange($staff, ['shipping_amount_override' => 0], $key)->assertCreated()
            ->assertJsonPath('data.return.status', 'exchanged')->assertJsonPath('data.payment_link', null)
            ->assertJsonPath('data.order.source_order_id', $order['id'])->assertJsonPath('data.order.tags', ['exchange'])
            ->assertJsonPath('data.order.channel', $order['channel'])->assertJsonPath('data.order.subtotal_amount', 3000)
            ->assertJsonPath('data.order.discount_amount', 1000)->assertJsonPath('data.order.total_amount', 2000)
            ->assertJsonPath('data.return.price_difference_amount', 2000)->json('data');
        $this->assertSame($res['order']['id'], $res['return']['exchange_order']['id']);
        $exchange($staff, ['shipping_amount_override' => 0], $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true');
        $exchange($h, [])->assertStatus(409);
        $this->inTenant($tenant, function () use ($big) {
            $this->assertSame(2, Order::query()->count());
            $this->assertSame(1, Inventory::query()->where('variant_id', $big)->value('committed'));
        });
    }

    #[Group('security')]
    public function test_negative_exchange_difference_needs_an_owner_or_admin(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order, 'tenant' => $tenant] = $this->delivered();
        [, $cheap] = $this->stocked($h, $store, 500, 5);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $ret = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => 'exchange', 'reason' => 'changed_mind',
            'lines' => [['order_item_id' => $order['items'][1]['id'], 'quantity' => 1, 'exchange_variant_id' => $cheap]]])->json('data');
        $this->api($h, 'POST', $this->r($store, "/{$ret['id']}/approve"))->assertOk();
        $this->api($h, 'POST', $this->r($store, "/{$ret['id']}/receive"), ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true], 'lines' => [['return_item_id' => $ret['items'][0]['id'], 'restock_quantity' => 1]]])->assertOk();
        $this->api($staff + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->r($store, "/{$ret['id']}/exchange-order"), ['shipping_amount_override' => 0])->assertForbidden();
        $this->inTenant($tenant, fn () => $this->assertSame(1, Order::query()->count(), 'nothing was placed'));
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->r($store, "/{$ret['id']}/exchange-order"), ['shipping_amount_override' => 0])->assertCreated()
            ->assertJsonPath('data.order.total_amount', 0)->assertJsonPath('data.return.price_difference_amount', -1500);
    }

    public function test_list_filters_counts_and_kpis(): void
    {
        ['store' => $store, 'h' => $h, 'order' => $order] = $this->delivered();
        $mk = fn (string $type, int $item, ?string $variant = null) => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/returns", ['type' => $type, 'reason' => $type === 'return' ? 'damaged' : 'wrong_size',
            'lines' => [['order_item_id' => $order['items'][$item]['id'], 'quantity' => 1, 'exchange_variant_id' => $variant]]])->assertCreated()->json('data');
        $one = $mk('return', 0);
        $two = $mk('exchange', 1, $order['items'][0]['variant_id']);
        $this->api($h, 'POST', $this->r($store, "/{$one['id']}/approve"))->assertOk();
        $this->api($h, 'POST', $this->r($store, "/{$one['id']}/receive"), ['checks' => ['tags_intact' => true, 'unused' => true, 'original_packaging' => true], 'lines' => [['return_item_id' => $one['items'][0]['id'], 'restock_quantity' => 1]]])->assertOk();

        $list = $this->api($h, 'GET', $this->r($store))->assertOk()
            ->assertJsonPath('meta.counts.open', 2)->assertJsonPath('meta.counts.requested', 1)->assertJsonPath('meta.counts.received', 1)
            ->assertJsonPath('meta.kpis.open', 2)->assertJsonPath('meta.kpis.return_rate_30d', 2)->assertJsonPath('meta.kpis.restocked_units_month', 1)
            ->assertJsonPath('meta.kpis.money_lost_amount', 0)->assertJsonPath('data.0.number', 'RT-0002')->assertJsonPath('data.0.courier', 'manual')
            ->assertJsonPath('data.0.items_preview.0.quantity', 1);
        $this->assertCount(2, $list->json('data'));
        $this->api($h, 'GET', $this->r($store).'?filter[status]=received')->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $one['id']);
        $this->api($h, 'GET', $this->r($store).'?filter[status]=open&filter[type]=exchange')->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $two['id']);
        $this->api($h, 'GET', $this->r($store).'?filter[reason]=damaged')->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->r($store).'?filter[provider]=steadfast')->assertJsonCount(0, 'data');
        $this->api($h, 'GET', $this->r($store).'?q=RT-0001')->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $one['id']);
        $this->api($h, 'GET', $this->r($store).'?q='.$order['number'])->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $this->r($store).'?q=01811223344')->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $this->r($store).'?filter[status]=bogus')->assertStatus(422);
    }

    #[Group('tenancy')]
    public function test_returns_are_isolated_by_tenant_and_store(): void
    {
        $a = $this->delivered('alpha');
        $b = $this->delivered('bravo');
        $retB = $this->api($b['h'], 'POST', "/api/v1/stores/{$b['store']->id}/orders/{$b['order']['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $b['order']['items'][0]['id'], 'quantity' => 1]]])->json('data');
        $retA = $this->api($a['h'], 'POST', "/api/v1/stores/{$a['store']->id}/orders/{$a['order']['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $a['order']['items'][0]['id'], 'quantity' => 1]]])->json('data');
        $this->api($a['h'], 'POST', "/api/v1/stores/{$a['store']->id}/returns/{$retA['id']}/notes", ['body' => 'hi'])->assertCreated();
        foreach ([ReturnRequest::class, ReturnItem::class, ReturnEvent::class] as $model) {
            $this->assertStoreIsolation($model, $a['tenant'], $a['store'], $b['store']);
            $this->assertStoreIsolation($model, $b['tenant'], $b['store'], $a['store']);
        }
        $sA = $a['store']->id;
        $this->assertTenantIsolation($a['h'], [
            ['GET', "/api/v1/stores/{$sA}/returns/{$retB['id']}"],
            ['POST', "/api/v1/stores/{$sA}/returns/{$retB['id']}/approve"],
            ['POST', "/api/v1/stores/{$sA}/returns/{$retB['id']}/notes", ['body' => 'x']],
            ['POST', "/api/v1/stores/{$sA}/orders/{$b['order']['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $b['order']['items'][0]['id'], 'quantity' => 1]]]],
            ['PUT', "/api/v1/stores/{$sA}/orders/{$b['order']['id']}/items", ['revision' => 1, 'reason' => 'other', 'items' => [['id' => $b['order']['items'][0]['id'], 'quantity' => 1]]]],
            ['POST', "/api/v1/stores/{$sA}/orders/{$b['order']['id']}/restock", ['lines' => [['item_id' => $b['order']['items'][0]['id'], 'quantity' => 1]]]],
        ]);
        // A foreign order item in A's own return → 422, not 404 / not created
        $this->api($a['h'], 'POST', "/api/v1/stores/{$sA}/orders/{$a['order']['id']}/returns", ['type' => 'return', 'reason' => 'other', 'lines' => [['order_item_id' => $b['order']['items'][0]['id'], 'quantity' => 1]]])
            ->assertStatus(422);
        $this->assertSame('RT-0001', $retA['number']);
        $this->assertSame('RT-0001', $retB['number']);
    }
}
