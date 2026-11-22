<?php

namespace Tests\Feature\Commerce;

use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** PHASE-5B §4.9 / §8 / §13 "Order changes": edit items (P5B-60–62), restock after a courier return (P5B-69). */
class OrderChangesTest extends TestCase
{
    use CommerceFixtures, ForksRaces, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    private function url($store, string $id, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/orders/{$id}{$suffix}";
    }

    private function stock(Tenant $tenant, string $variant): array
    {
        return $this->inTenant($tenant, function () use ($variant) {
            $i = Inventory::query()->where('variant_id', $variant)->firstOrFail();

            return [$i->on_hand, $i->committed];
        });
    }

    /** @return array{0: Tenant, 1: Store, 2: array<string, string>, 3: string, 4: string, 5: array<string, mixed>} */
    private function confirmedOrder(): array
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $a] = $this->stocked($h, $store, 1000, 10);
        [, $b] = $this->stocked($h, $store, 2000, 10);
        $body = $this->manualBody($a, 2, ['notify_customer' => false]);
        $body['items'][] = ['variant_id' => $b, 'quantity' => 3];
        $order = $this->manual($h, $store, $body)->assertCreated()->json('data');
        $order = $this->api($h, 'POST', $this->url($store, $order['id'], '/confirm'), ['notify_customer' => false])->assertOk()->json('data');

        return [$tenant, $store, $h, $a, $b, $order];
    }

    #[Group('security')]
    public function test_edit_items_moves_stock_by_difference_and_reprices(): void
    {
        [$tenant, $store, $h, $a, $b, $order] = $this->confirmedOrder();
        [, $c] = $this->stocked($h, $store, 5000, 4);
        $shipping = $order['shipping_amount'];
        $this->assertSame(8000 + $shipping, $order['total_amount']);
        $this->inTenant($tenant, fn () => ProductVariant::query()->whereKey($a)->update(['price_amount' => 9999]));
        [$itemA, $itemB] = $order['items'];

        // A 2 → 4 (snapshot price kept), B removed (omitted), C added at the current price; tampered price ignored (S39)
        $input = ['revision' => $order['revision'], 'items' => [
            ['id' => $itemA['id'], 'quantity' => 4, 'unit_price_amount' => 1],
            ['variant_id' => $c, 'quantity' => 2],
        ], 'reason' => 'customer_request', 'note' => 'Called to change', 'notify_customer' => false];

        $quote = $this->api($h, 'POST', $this->url($store, $order['id'], '/items/quote'), $input)->assertOk();
        $quote->assertJsonPath('data.subtotal_amount', 4 * 1000 + 2 * 5000)->assertJsonPath('data.total_amount', 14000 + $shipping)
            ->assertJsonPath('data.previous_total_amount', 8000 + $shipping)->assertJsonPath('data.due_delta_amount', 6000)
            ->assertJsonPath('data.lines.0.change', 'changed')->assertJsonPath('data.lines.0.unit_price_amount', 1000)
            ->assertJsonPath('data.lines.1.change', 'added')->assertJsonPath('data.lines.1.id', null)
            ->assertJsonPath('data.lines.2.change', 'removed')->assertJsonPath('data.lines.2.quantity', 0);
        $this->assertSame([10, 2], $this->stock($tenant, $a), 'quote writes nothing');

        $r = $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), $input)->assertOk()
            ->assertJsonPath('data.total_amount', 14000 + $shipping)->assertJsonPath('data.revision', $order['revision'] + 1)
            ->assertJsonPath('data.items.0.quantity', 4)->assertJsonPath('data.items.0.unit_price_amount', 1000)
            ->assertJsonPath('data.items.1.unit_price_amount', 5000)->assertJsonPath('data.due_amount', 14000 + $shipping)
            ->assertJsonPath('meta.notices', []);
        $this->assertCount(2, $r->json('data.items'));
        $this->assertSame([10, 4], $this->stock($tenant, $a));
        $this->assertSame([10, 0], $this->stock($tenant, $b));
        $this->assertSame([4, 2], $this->stock($tenant, $c));

        $this->inTenant($tenant, function () use ($order, $shipping) {
            $this->assertSame(14000 + $shipping, Payment::query()->where('order_id', $order['id'])->where('provider', 'cod')->where('status', 'pending')->value('amount'));
            $event = OrderEvent::query()->where('order_id', $order['id'])->where('type', 'items_edited')->sole();
            $this->assertSame('Called to change', $event->body);
            $this->assertSame('customer_request', $event->meta['reason']);
            $this->assertCount(3, $event->meta['changes']);
            $this->assertSame(0, InventoryMovement::query()->count() - 3, 'only the 3 initial stock movements: commits are not ledger rows');
        });

        // stale revision → 409; quantity beyond stock → out_of_stock with the line path
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), $input)->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $fresh = $r->json('data');
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $fresh['revision'], 'reason' => 'other', 'items' => [
            ['id' => $fresh['items'][0]['id'], 'quantity' => 4], ['id' => $fresh['items'][1]['id'], 'quantity' => 7],
        ]])->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock')->assertJsonStructure(['error' => ['details' => ['items.1.quantity']]]);
        $this->assertSame([4, 2], $this->stock($tenant, $c));
    }

    public function test_validation_foreign_and_unknown_ids(): void
    {
        [, $store, $h, , , $order] = $this->confirmedOrder();
        [, , $other, $h2] = $this->liveShop('other');
        [, $foreign] = $this->stocked($h2, $other, 1000, 5);
        $put = fn (array $items) => $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'], 'reason' => 'other', 'items' => $items]);

        $put([['variant_id' => $foreign, 'quantity' => 1], ['id' => $order['items'][0]['id'], 'quantity' => 1]])->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['items.0.variant_id']]]);
        $put([['id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'quantity' => 1]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items.0.id']]]);
        $put([['id' => $order['items'][0]['id'], 'quantity' => 0]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items']]]);
        $put([['id' => $order['items'][0]['id'], 'quantity' => 1], ['variant_id' => $order['items'][0]['variant_id'], 'quantity' => 1]])->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['items.1.variant_id']]]);
        $put([['id' => $order['items'][0]['id'], 'quantity' => 100]])->assertStatus(422);
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['items' => [['id' => $order['items'][0]['id'], 'quantity' => 1]]])->assertStatus(422);
    }

    public function test_coupon_is_kept_or_removed_when_below_its_minimum(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $v] = $this->stocked($h, $store, 100000, 20);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'BIG', 'type' => 'percentage', 'percent_bps' => 1000, 'min_subtotal_amount' => 200000, 'status' => 'active'])->assertCreated();
        $order = $this->manual($h, $store, $this->manualBody($v, 3, ['coupon_code' => 'BIG', 'notify_customer' => false]))->assertCreated()->json('data');
        $this->assertSame(30000, $order['discount_amount']);
        $item = $order['items'][0]['id'];

        // 3 → 2: still ≥ minimum, coupon re-applied to the new subtotal
        $order = $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'], 'reason' => 'other', 'items' => [['id' => $item, 'quantity' => 2]]])
            ->assertOk()->assertJsonPath('data.discount_amount', 20000)->assertJsonPath('data.coupon_code', 'BIG')->json('data');
        // 2 → 1: below the minimum → removed, redemption released, notice
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'], 'reason' => 'other', 'items' => [['id' => $item, 'quantity' => 1]]])
            ->assertOk()->assertJsonPath('data.discount_amount', 0)->assertJsonPath('data.coupon_code', null)
            ->assertJsonPath('meta.notices.0', fn ($n) => str_contains($n, 'BIG'));
        $this->inTenant($tenant, function () use ($order) {
            $this->assertSame(CouponRedemption::RELEASED, CouponRedemption::query()->where('order_id', $order['id'])->value('status'));
            $this->assertSame(0, Coupon::query()->where('code', 'BIG')->value('used_count'));
        });
    }

    public function test_shipping_kept_recalculated_or_overridden_and_total_below_paid(): void
    {
        [$tenant, $store, $h, , , $order] = $this->confirmedOrder();
        $item = $order['items'][0]['id'];
        $zone = $order['shipping_amount'];
        $this->inTenant($tenant, fn () => Order::query()->whereKey($order['id'])->update(['shipping_amount' => 1, 'total_amount' => 8001]));
        $edit = fn (array $extra, int $rev) => $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $rev, 'reason' => 'other', 'items' => [['id' => $item, 'quantity' => 1]]] + $extra);

        $o = $edit([], $order['revision'])->assertOk()->assertJsonPath('data.shipping_amount', 1)->json('data');
        $o = $edit(['recalculate_shipping' => true], $o['revision'])->assertOk()->assertJsonPath('data.shipping_amount', $zone)->assertJsonPath('data.total_amount', 1000 + $zone)->json('data');
        $o = $edit(['shipping_amount_override' => 0], $o['revision'])->assertOk()->assertJsonPath('data.shipping_amount', 0)->assertJsonPath('data.shipping_overridden', true)->json('data');

        // a paid advance larger than the new total → 422 total_below_paid, nothing changes
        $this->inTenant($tenant, fn () => Order::query()->whereKey($order['id'])->update(['paid_amount' => 900, 'payment_status' => 'partially_paid']));
        $this->api($h, 'POST', $this->url($store, $order['id'], '/items/quote'), ['items' => [['id' => $item, 'quantity' => 1]], 'shipping_amount_override' => 0, 'recalculate_shipping' => false])
            ->assertOk()->assertJsonPath('data.notices', []);
        $edit(['shipping_amount_override' => 0], $o['revision'])->assertOk()->assertJsonPath('data.due_amount', 100)->assertJsonPath('data.payment_status', 'partially_paid');
        $this->inTenant($tenant, fn () => Order::query()->whereKey($order['id'])->update(['paid_amount' => 1000, 'payment_status' => 'paid']));
        $o = $this->api($h, 'GET', $this->url($store, $order['id']))->json('data');
        $this->api($h, 'POST', $this->url($store, $order['id'], '/items/quote'), ['items' => [['id' => $item, 'quantity' => 1]], 'shipping_amount_override' => 0])
            ->assertOk()->assertJsonPath('data.due_amount', 0);
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $o['revision'], 'reason' => 'other', 'items' => [['id' => $item, 'quantity' => 1]], 'shipping_amount_override' => 0])
            ->assertOk()->assertJsonPath('data.payment_status', 'paid');
        $this->inTenant($tenant, fn () => Order::query()->whereKey($order['id'])->update(['paid_amount' => 5000]));
        $o = $this->api($h, 'GET', $this->url($store, $order['id']))->json('data');
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $o['revision'], 'reason' => 'other', 'items' => [['id' => $item, 'quantity' => 1]], 'shipping_amount_override' => 0])
            ->assertStatus(422)->assertJsonPath('error.code', 'total_below_paid');
    }

    public function test_states_and_courier_booking_block_edits(): void
    {
        [$tenant, $store, $h, , , $order] = $this->confirmedOrder();
        $body = ['revision' => $order['revision'], 'reason' => 'other', 'items' => [['id' => $order['items'][0]['id'], 'quantity' => 1]]];
        // Q56: an active courier parcel → 409 shipment_booked
        $this->inTenant($tenant, function () use ($order, $store) {
            $s = new Shipment;
            $s->store_id = $store->id;
            $s->order_id = $order['id'];
            $s->provider = 'steadfast';
            $s->status = 'shipped';
            $s->save();
        });
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), $body)->assertStatus(409)->assertJsonPath('error.code', 'shipment_booked');
        $this->inTenant($tenant, fn () => Shipment::query()->where('order_id', $order['id'])->update(['status' => 'cancelled']));
        $this->api($h, 'POST', $this->url($store, $order['id'], '/ship'))->assertOk();
        $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'] + 1] + $body)->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
    }

    public function test_staff_can_edit_without_seeing_costs_and_sms_is_sent_per_edit(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $v] = $this->stocked($h, $store, 1000, 10, ['cost_amount' => 600]);
        $order = $this->manual($h, $store, $this->manualBody($v, 1, ['notify_customer' => false]))->json('data');
        $item = $order['items'][0]['id'];
        $this->api($staff, 'POST', $this->url($store, $order['id'], '/items/quote'), ['items' => [['id' => $item, 'quantity' => 2]]])
            ->assertOk()->assertJsonPath('data.lines.0.unit_cost_amount', null);
        $sent = fn () => count(app(SmsGateway::class)->sent);
        $before = $sent();
        $o = $this->api($staff, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'], 'reason' => 'customer_request', 'items' => [['id' => $item, 'quantity' => 2]], 'notify_customer' => true])->assertOk()->json('data');
        $this->api($staff, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $o['revision'], 'reason' => 'customer_request', 'items' => [['id' => $item, 'quantity' => 3]], 'notify_customer' => true])->assertOk();
        $this->api($staff, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $o['revision'] + 1, 'reason' => 'customer_request', 'items' => [['id' => $item, 'quantity' => 1]], 'notify_customer' => false])->assertOk();
        $this->assertSame($before + 2, $sent(), 'one order_updated SMS per edit that asked for it');
        $this->assertStringContainsString($order['number'], end(app(SmsGateway::class)->sent)['text'] ?? json_encode(end(app(SmsGateway::class)->sent)));
    }

    public function test_restock_a_courier_returned_order(): void
    {
        [$tenant, $store, $h, $a, $b, $order] = $this->confirmedOrder();
        [$ia, $ib] = $order['items'];
        $restock = fn (array $lines) => $this->api($h, 'POST', $this->url($store, $order['id'], '/restock'), ['lines' => $lines, 'note' => 'Back from Steadfast']);
        $restock([['item_id' => $ia['id'], 'quantity' => 1]])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', $this->url($store, $order['id'], '/ship'))->assertOk();
        $this->api($h, 'POST', $this->url($store, $order['id'], '/return'), ['restock' => []])->assertOk(); // courier return: nothing restocked yet

        $restock([['item_id' => $ib['id'], 'quantity' => 4]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['lines.0.quantity']]]);
        $restock([['item_id' => $ia['id'], 'quantity' => 2], ['item_id' => $ib['id'], 'quantity' => 1]])->assertOk()
            ->assertJsonPath('data.items.0.restocked_quantity', 2)->assertJsonPath('data.items.1.restocked_quantity', 1);
        $restock([['item_id' => $ib['id'], 'quantity' => 2]])->assertOk()->assertJsonPath('data.items.1.restocked_quantity', 3);
        $restock([['item_id' => $ib['id'], 'quantity' => 1]])->assertStatus(422);
        $this->assertSame([10, 0], $this->stock($tenant, $a));
        $this->assertSame([10, 0], $this->stock($tenant, $b));
        $this->inTenant($tenant, fn () => $this->assertSame(3, InventoryMovement::query()->where('reason', 'order_returned')->count()));
    }

    /** S36: concurrent edit (+1 of the last unit) and a checkout of the same unit never oversell (Postgres). */
    #[Group('race')]
    #[Group('perf')]
    public function test_concurrent_edit_and_checkout_on_the_last_unit_do_not_oversell(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, $store, $h] = $this->liveShop();
            [, $v] = $this->stocked($h, $store, 1000, 2);
            $order = $this->manual($h, $store, $this->manualBody($v, 1, ['notify_customer' => false]))->json('data');
            $cart = $this->cartWith($store, $v);
            $results = $this->parallel(2, fn (int $i) => $i === 0
                ? $this->api($h, 'PUT', $this->url($store, $order['id'], '/items'), ['revision' => $order['revision'], 'reason' => 'other', 'items' => [['id' => $order['items'][0]['id'], 'quantity' => 2]]])->status()
                : $this->checkout($store, $cart, $this->checkoutBody(8000))->status());
            sort($results);
            $this->assertSame([200, 422], array_map(fn ($s) => $s === 201 ? 200 : $s, $results), json_encode($results));
            $this->assertSame(2, Inventory::withoutTenancy()->where('variant_id', $v)->value('committed'));
        } finally {
            $this->raceCleanup();
        }
    }
}
