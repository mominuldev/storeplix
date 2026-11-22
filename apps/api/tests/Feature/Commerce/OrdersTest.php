<?php

namespace Tests\Feature\Commerce;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderStateMachine;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.7 orders (P5-17..P5-22, P5-27) and §12 "Orders". */
class OrdersTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    private function url($store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/orders{$suffix}";
    }

    #[Group('security')]
    public function test_full_lifecycle_moves_stock_payments_and_counters(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 10);
        $this->placeOrder($store, $variant, 3);
        $id = $this->api($h, 'GET', $this->url($store))->assertOk()->json('data.0.id');
        $order = fn () => $this->api($h, 'GET', $this->url($store, "/{$id}"))->assertOk();
        $order()->assertJsonPath('data.allowed_transitions', ['confirmed', 'cancelled'])->assertJsonPath('data.items.0.current_stock', ['available' => 7, 'tracked' => true])
            ->assertJsonPath('data.can', ['edit' => true, 'cancel' => true, 'refund' => false]);

        $this->api($h, 'POST', $this->url($store, "/{$id}/ready"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', $this->url($store, "/{$id}/confirm"))->assertOk()->assertJsonPath('data.status', 'confirmed')->assertJsonPath('data.revision', 2);
        $this->api($h, 'POST', $this->url($store, "/{$id}/ready"))->assertOk()->assertJsonPath('data.status', 'ready_to_ship');
        // S14: tracking links are https only (no http:, javascript:)
        $this->api($h, 'POST', $this->url($store, "/{$id}/ship"), ['carrier_name' => 'Steadfast', 'tracking_code' => 'SF123', 'tracking_url' => 'http://x.test'])->assertStatus(422);
        $this->api($h, 'POST', $this->url($store, "/{$id}/ship"), ['carrier_name' => 'Steadfast', 'tracking_code' => 'SF123', 'tracking_url' => 'javascript:alert(1)'])->assertStatus(422);
        $this->api($h, 'POST', $this->url($store, "/{$id}/ship"), ['carrier_name' => 'Steadfast', 'tracking_code' => 'SF123', 'tracking_url' => 'https://steadfast.com.bd/t/SF123'])->assertOk()
            ->assertJsonPath('data.status', 'shipped')->assertJsonPath('data.shipment.carrier_name', 'Steadfast')->assertJsonPath('data.shipment.cod_amount', 307000);

        $this->tenancy()->run($tenant, function () use ($variant) {
            $inv = Inventory::query()->where('variant_id', $variant)->firstOrFail();
            $this->assertSame([7, 0], [$inv->on_hand, $inv->committed]);
            $m = InventoryMovement::query()->where('reason', 'order_shipped')->firstOrFail();
            $this->assertSame([-3, 7, 'order'], [$m->delta, $m->on_hand_after, $m->reference_type]);
        });
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory/movements?filter[reason]=order_shipped")->assertOk()
            ->assertJsonPath('data.0.reference.type', 'order');

        $this->api($h, 'POST', $this->url($store, "/{$id}/deliver"))->assertOk()->assertJsonPath('data.status', 'delivered')
            ->assertJsonPath('data.payment_status', 'paid')->assertJsonPath('data.paid_amount', 307000)->assertJsonPath('data.due_amount', 0)
            ->assertJsonPath('data.payments.0.status', 'succeeded')->assertJsonPath('data.allowed_transitions', [])
            ->assertJsonPath('data.customer.delivered_orders_count', 1)->assertJsonPath('data.customer.total_spent_amount', 307000);

        // refunds: partial, over → 422, full; idempotent
        $key = (string) Str::uuid();
        $refund = fn (int $amount, ?string $k = null) => $this->api($h + ['Idempotency-Key' => $k ?? (string) Str::uuid()], 'POST', $this->url($store, "/{$id}/refunds"), ['amount' => $amount, 'method' => 'bkash_personal', 'reference' => 'TRX1']);
        $refund(7000, $key)->assertCreated()->assertJsonPath('data.type', 'refund')->assertJsonPath('data.provider', 'manual');
        $refund(7000, $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true');
        $refund(300001)->assertStatus(422)->assertJsonPath('error.code', 'refund_exceeds_paid');
        $order()->assertJsonPath('data.payment_status', 'partially_refunded')->assertJsonPath('data.refunded_amount', 7000);
        $refund(300000)->assertCreated();
        $order()->assertJsonPath('data.payment_status', 'refunded')->assertJsonPath('data.customer.total_spent_amount', 0)
            ->assertJsonPath('data.can.refund', false);
        $this->api($h, 'POST', $this->url($store, "/{$id}/refunds"), ['amount' => 1, 'method' => 'cash'])->assertStatus(400);
    }

    public function test_cancel_releases_stock_coupon_and_counters(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5);
        $this->manual($h, $store, $this->manualBody($variant, 4))->assertCreated();
        $id = Order::withoutTenancy()->value('id');
        $this->tenancy()->run($tenant, fn () => $this->assertSame(4, Inventory::query()->where('variant_id', $variant)->value('committed')));
        $this->api($h, 'POST', $this->url($store, "/{$id}/cancel"), ['reason' => 'nope'])->assertStatus(422);
        $this->api($h, 'POST', $this->url($store, "/{$id}/cancel"), ['reason' => 'unreachable', 'note' => 'No answer 3 times', 'notify_customer' => false])->assertOk()
            ->assertJsonPath('data.status', 'cancelled')->assertJsonPath('data.cancel_reason', 'unreachable')
            ->assertJsonPath('data.payments.0.status', 'cancelled')->assertJsonPath('data.customer.orders_count', 0)
            ->assertJsonPath('data.events.0.body', 'No answer 3 times');
        $this->tenancy()->run($tenant, function () use ($variant) {
            $this->assertSame([5, 0], [Inventory::query()->where('variant_id', $variant)->value('on_hand'), Inventory::query()->where('variant_id', $variant)->value('committed')]);
        });
        $this->api($h, 'POST', $this->url($store, "/{$id}/confirm"))->assertStatus(409);
    }

    public function test_return_restocks_selected_quantities(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $a] = $this->stocked($h, $store, 1000, 10);
        [, $b] = $this->stocked($h, $store, 2000, 10);
        $body = $this->manualBody($a, 2);
        $body['items'][] = ['variant_id' => $b, 'quantity' => 3];
        $order = $this->manual($h, $store, $body)->assertCreated()->json('data');
        foreach (['confirm', 'ship'] as $step) {
            $this->api($h, 'POST', $this->url($store, "/{$order['id']}/{$step}"))->assertOk();
        }
        $items = $order['items'];
        $this->api($h, 'POST', $this->url($store, "/{$order['id']}/return"), ['restock' => [['item_id' => $items[1]['id'], 'quantity' => 4]]])->assertStatus(422)
            ->assertJsonPath('error.details', ['restock.0.quantity' => ['You can restock at most 3.']]);
        $this->api($h, 'POST', $this->url($store, "/{$order['id']}/return"), ['restock' => [['item_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'quantity' => 1]]])->assertStatus(422);
        $this->api($h, 'POST', $this->url($store, "/{$order['id']}/return"), ['restock' => [['item_id' => $items[0]['id'], 'quantity' => 2], ['item_id' => $items[1]['id'], 'quantity' => 1]], 'note' => 'Box damaged'])
            ->assertOk()->assertJsonPath('data.status', 'returned')->assertJsonPath('data.items.1.restocked_quantity', 1)
            ->assertJsonPath('data.payments.0.status', 'cancelled')->assertJsonPath('data.customer.returned_orders_count', 1);
        $this->tenancy()->run($tenant, function () use ($a, $b) {
            $this->assertSame(10, Inventory::query()->where('variant_id', $a)->value('on_hand'));
            $this->assertSame(8, Inventory::query()->where('variant_id', $b)->value('on_hand'));
            $this->assertSame(2, InventoryMovement::query()->where('reason', 'order_returned')->count());
        });
    }

    /** S10: every (from, to) pair against the transition endpoints. */
    #[Group('security')]
    public function test_state_machine_matrix(): void
    {
        foreach (Order::STATUSES as $from) {
            foreach (Order::STATUSES as $to) {
                $expected = in_array($to, OrderStateMachine::TRANSITIONS[$from], true);
                $this->assertSame($expected, OrderStateMachine::can($from, $to), "{$from} → {$to}");
            }
        }
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 100, ['track_inventory' => false]);
        $endpoints = ['confirmed' => 'confirm', 'ready_to_ship' => 'ready', 'shipped' => 'ship', 'delivered' => 'deliver', 'returned' => 'return', 'cancelled' => 'cancel'];
        $bodies = ['return' => ['restock' => []], 'cancel' => ['reason' => 'other']];
        foreach (['pending', 'confirmed', 'ready_to_ship', 'shipped', 'delivered', 'returned', 'cancelled'] as $from) {
            foreach ($endpoints as $to => $endpoint) {
                $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data.id');
                $this->tenancy()->run($tenant, fn () => Order::query()->whereKey($id)->update(['status' => $from]));
                $res = $this->api($h, 'POST', $this->url($store, "/{$id}/{$endpoint}"), $bodies[$endpoint] ?? []);
                $ok = OrderStateMachine::can($from, $to);
                $this->assertSame($ok ? 200 : 409, $res->status(), "{$from} → {$to}");
            }
        }
    }

    #[Group('security')]
    public function test_staff_cannot_cancel_paid_or_refund_and_never_sees_cost(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $variant] = $this->stocked($h, $store, 1000, 10, ['cost_amount' => 600]);
        $id = $this->manual($staff, $store, $this->manualBody($variant))->assertCreated()
            ->assertJsonPath('data.items.0.unit_cost_amount', null)->json('data.id');
        $this->api($h, 'GET', $this->url($store, "/{$id}"))->assertJsonPath('data.items.0.unit_cost_amount', 600);
        $this->tenancy()->run($tenant, fn () => Order::query()->whereKey($id)->update(['paid_amount' => 500, 'payment_status' => 'partially_paid']));
        $this->api($staff, 'GET', $this->url($store, "/{$id}"))->assertJsonPath('data.allowed_transitions', ['confirmed']);
        $this->api($staff, 'POST', $this->url($store, "/{$id}/cancel"), ['reason' => 'other'])->assertForbidden()
            ->assertJsonPath('error.message', 'Only owners and managers can cancel paid orders.');
        $this->api($staff + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->url($store, "/{$id}/refunds"), ['amount' => 100, 'method' => 'cash'])->assertForbidden();
        $this->api($h, 'POST', $this->url($store, "/{$id}/cancel"), ['reason' => 'other'])->assertOk();
        // staff may cancel unpaid orders
        $other = $this->manual($staff, $store, $this->manualBody($variant))->json('data.id');
        $this->api($staff, 'POST', $this->url($store, "/{$other}/cancel"), ['reason' => 'fake_order'])->assertOk();
    }

    public function test_patch_edits_contact_address_with_hint_and_revision(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $o = $this->manual($h, $store, $this->manualBody($variant))->json('data');
        $this->api($h, 'PATCH', $this->url($store, "/{$o['id']}"), ['revision' => 99, 'tags' => ['vip']])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $res = $this->api($h, 'PATCH', $this->url($store, "/{$o['id']}"), [
            'revision' => 1, 'contact' => ['name' => 'Nusrat J.', 'phone' => '01811223399'], 'tags' => ['vip', 'vip', ' gift '],
            'shipping_address' => ['district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur', 'address_line' => 'Section 2, Road 1'],
            'total_amount' => 1, 'status' => 'delivered',
        ])->assertOk()->assertJsonPath('data.revision', 2)->assertJsonPath('data.contact.phone', '8801811223399')
            ->assertJsonPath('data.tags', ['vip', 'gift'])->assertJsonPath('data.status', 'pending')
            ->assertJsonPath('data.total_amount', $o['total_amount'])->assertJsonPath('data.shipping_address.thana', 'Mirpur')
            ->assertJsonPath('meta.shipping_hint.zone_name', 'Inside Dhaka')->assertJsonPath('meta.shipping_hint.amount', 7000);
        $this->assertSame(['contact.name', 'contact.phone', 'shipping_address', 'tags'], $res->json('data.events.0.meta.fields'));
        $this->api($h, 'POST', $this->url($store, "/{$o['id']}/notes"), ['body' => 'Called twice'])->assertCreated()->assertJsonPath('data.type', 'note');
        $this->api($h, 'POST', $this->url($store, "/{$o['id']}/cancel"), ['reason' => 'other'])->assertOk();
        $this->api($h, 'PATCH', $this->url($store, "/{$o['id']}"), ['revision' => 3, 'tags' => []])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
    }

    public function test_bulk_skips_wrong_states_and_rejects_foreign_ids(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, , , $hB] = $this->liveShop('other');
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $ids = [];
        for ($i = 0; $i < 3; $i++) {
            $ids[] = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        }
        $this->api($h, 'POST', $this->url($store, "/{$ids[2]}/cancel"), ['reason' => 'other'])->assertOk();
        $this->api($h, 'POST', $this->url($store, '/bulk'), ['action' => 'confirm', 'ids' => [...$ids, '01jzzzzzzzzzzzzzzzzzzzzzzz']])->assertStatus(422)
            ->assertJsonPath('error.details', ['ids.3' => ['Unknown order.']]);
        $this->assertSame(0, Order::withoutTenancy()->where('status', 'confirmed')->count());
        $this->api($h, 'POST', $this->url($store, '/bulk'), ['action' => 'confirm', 'ids' => $ids])->assertOk()
            ->assertJsonPath('data', ['action' => 'confirm', 'updated' => 2, 'skipped' => [['id' => $ids[2], 'reason' => 'invalid_state_transition']]]);
        $this->api($h, 'POST', $this->url($store, '/bulk'), ['action' => 'ready', 'ids' => $ids])->assertOk()->assertJsonPath('data.updated', 2);
    }

    public function test_manual_orders_use_checkout_pricing_override_is_audited_and_errors(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [$p, $variant] = $this->stocked($h, $store, 100000, 3);
        $draft = $this->createProduct($h, $store, $this->simpleProduct('Draft item', 50000, [], ['initial_on_hand' => 2]))['variants'][0]['id'];
        [, , , $hB] = $this->liveShop('bravo');
        [, $foreign] = $this->stocked($hB, $this->storeOf($hB));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'TEN', 'type' => 'percentage', 'percent_bps' => 1000, 'status' => 'active'])->assertCreated();

        $quote = $this->api($h, 'POST', $this->url($store, '/quote'), $this->manualBody($variant, 2, ['coupon_code' => 'TEN', 'shipping_address' => ['district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur']]))
            ->assertOk()->assertJsonPath('data.subtotal_amount', 200000)->assertJsonPath('data.discount_amount', 20000)
            ->assertJsonPath('data.shipping_amount', 7000)->assertJsonPath('data.total_amount', 187000)->assertJsonPath('data.coupon_error', null)
            ->assertJsonPath('data.zone.zone_name', 'Inside Dhaka')->assertJsonPath('data.lines.0.issue', null)
            ->assertJsonPath('data.customer.id', null);
        $this->api($h, 'POST', $this->url($store, '/quote'), $this->manualBody($variant, 5, ['coupon_code' => 'NOPE']))->assertOk()
            ->assertJsonPath('data.lines.0.issue', 'insufficient_stock')->assertJsonPath('data.coupon_error', "This code doesn't exist.");

        $this->manual($h, $store, $this->manualBody($foreign))->assertStatus(422)->assertJsonPath('error.details', ['items.0.variant_id' => ['Unknown variant.']]);
        $this->manual($h, $store, $this->manualBody($variant, 4))->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock');
        $this->manual($h, $store, $this->manualBody($variant, 1, ['channel' => 'website']))->assertStatus(422);
        $this->manual($h, $store, ['items' => [['variant_id' => $variant, 'quantity' => 1], ['variant_id' => $variant, 'quantity' => 1]]] + $this->manualBody($variant))->assertStatus(422);
        $this->api($h, 'POST', $this->url($store), $this->manualBody($variant))->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $o = $this->manual($h, $store, $this->manualBody($draft, 1, ['shipping_amount_override' => 2500, 'coupon_code' => 'ten']))->assertCreated()
            ->assertJsonPath('data.created_via', 'dashboard')->assertJsonPath('data.channel', 'facebook')
            ->assertJsonPath('data.shipping_amount', 2500)->assertJsonPath('data.shipping_overridden', true)
            ->assertJsonPath('data.discount_amount', 5000)->assertJsonPath('data.total_amount', 47500)
            ->json('data');
        $placed = collect($o['events'])->firstWhere('type', 'placed');
        $this->assertEquals(['computed_shipping_amount' => 13000, 'shipping_amount' => 2500, 'shipping_overridden' => true], array_intersect_key($placed['meta'], array_flip(['computed_shipping_amount', 'shipping_amount', 'shipping_overridden'])));
        $this->tenancy()->run($tenant, fn () => $this->assertTrue(DB::table('audit_logs')->where('action', 'order.shipping_overridden')->where('subject_id', $o['id'])->exists()));

        // archived product refused
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$p['id']}", ['revision' => 1, 'status' => 'archived'])->assertOk();
        $this->manual($h, $store, $this->manualBody($variant))->assertStatus(422)->assertJsonPath('error.details', ['items.0.variant_id' => ['This product is archived.']]);
    }

    public function test_manual_orders_stop_at_the_monthly_plan_limit(): void
    {
        $this->seed(PlanSeeder::class);
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 0, ['track_inventory' => false]);
        $this->tenancy()->run($tenant, function () {
            Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]);
        });
        FeatureGate::forget($tenant->id);
        $first = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->assertCreated()->json('data');
        $this->tenancy()->run($tenant, function () use ($first) {
            $order = Order::query()->findOrFail($first['id']);
            for ($i = 0; $i < 49; $i++) {
                $copy = $order->replicate(['number', 'sequence', 'idempotency_key']);
                $copy->number = 'X-'.$i;
                $copy->sequence = 5000 + $i;
                $copy->save();
            }
        });
        $this->manual($h, $store, $this->manualBody($variant))->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached');
        // storefront orders are always accepted (P5-27)
        $this->placeOrder($store, $variant, 1);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/dashboard")->assertJsonPath('data.orders.plan', ['used' => 51, 'limit' => 50]);
    }

    public function test_list_filters_search_and_counts(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $this->placeOrder($store, $variant, 1);
        $a = $this->manual($h, $store, $this->manualBody($variant, 1, ['channel' => 'instagram', 'contact' => ['name' => 'Farhana Rahman', 'phone' => '01556120987']]))->json('data');
        $b = $this->manual($h, $store, $this->manualBody($variant, 2))->json('data');
        $this->api($h, 'POST', $this->url($store, "/{$b['id']}/confirm"))->assertOk();

        $this->api($h, 'GET', $this->url($store))->assertOk()->assertJsonPath('meta.total', 3)
            ->assertJsonPath('meta.counts.all', 3)->assertJsonPath('meta.counts.pending', 2)->assertJsonPath('meta.counts.confirmed', 1)
            ->assertJsonPath('data.0.id', $b['id'])->assertJsonPath('data.0.items_count', 2);
        $this->api($h, 'GET', $this->url($store, '?filter[status]=pending'))->assertJsonPath('meta.total', 2)->assertJsonPath('meta.counts.all', 3);
        $this->api($h, 'GET', $this->url($store, '?filter[channel]=instagram'))->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.customer.name', 'Farhana Rahman');
        $this->api($h, 'GET', $this->url($store, '?q=farh'))->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->url($store, '?q=01556'))->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->url($store, '?q='.$a['number']))->assertJsonPath('data.0.id', $a['id']);
        $this->api($h, 'GET', $this->url($store, '?q=1001'))->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->url($store, '?filter[district_code]=dhaka'))->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->url($store, '?sort=-total'))->assertJsonPath('data.0.id', $b['id']);
        $this->api($h, 'GET', $this->url($store, '?filter[status]=nope'))->assertStatus(422);
        $customer = $this->api($h, 'GET', $this->url($store, "/{$a['id']}"))->json('data.customer.id');
        $this->api($h, 'GET', $this->url($store, "?filter[customer_id]={$customer}"))->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/customers/{$customer}")->assertJsonPath('data.orders_count', 1)
            ->assertJsonPath('data.delivered_orders_count', 0)->assertJsonPath('data.returned_orders_count', 0)->assertJsonPath('data.source', 'manual');
    }

    private function storeOf(array $headers): Store
    {
        return Store::withoutTenancy()->where('tenant_id', $headers['X-Tenant-Id'])->firstOrFail();
    }
}
