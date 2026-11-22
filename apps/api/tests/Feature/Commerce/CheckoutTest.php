<?php

namespace Tests\Feature\Commerce;

use App\Domain\Cart\Models\Cart;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Customers\Models\Customer;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Notifications\SendOrderMail;
use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Queue;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.4 checkout (P5-14, P5-15, P5-16, P5-24) and §12 "Checkout". */
class CheckoutTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_happy_path_places_a_cod_order_with_snapshots(): void
    {
        Queue::fake();
        [, $tenant, $store, $h] = $this->liveShop();
        [$p, $variant] = $this->stocked($h, $store, 120000, 5, ['cost_amount' => 70000, 'sku' => 'TSHIRT-1', 'compare_at_amount' => 150000]);

        $cart = $this->cartWith($store, $variant, 2);
        $this->sf($store, 'GET', '/cart', [], $cart)->assertJsonPath('data.estimated_total_amount', 240000);
        $res = $this->checkout($store, $cart, $this->checkoutBody(247000, ['contact' => ['email' => 'Rafi@Example.com']]))
            ->assertCreated()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('data.order.number', 'SH-1001')
            ->assertJsonPath('data.order.status', 'pending')
            ->assertJsonPath('data.order.subtotal_amount', 240000)
            ->assertJsonPath('data.order.shipping_amount', 7000)
            ->assertJsonPath('data.order.total_amount', 247000)
            ->assertJsonPath('data.order.due_amount', 247000)
            ->assertJsonPath('data.order.delivery.zone_name', 'Inside Dhaka')
            ->assertJsonPath('data.order.shipping_address.division', 'Dhaka')
            ->assertJsonPath('data.order.shipping_address.thana', 'Dhanmondi');
        $this->assertSame(43, strlen($res->json('data.confirmation_token')));
        $this->assertSame(
            ['product_name', 'variant_title', 'quantity', 'image', 'unit_price_amount', 'total_amount'],
            array_keys($res->json('data.order.lines.0')),
        );

        $this->tenancy()->run($tenant, function () use ($variant) {
            $order = Order::query()->with('items')->firstOrFail();
            $this->assertSame('storefront', $order->created_via);
            $this->assertSame('website', $order->channel);
            $this->assertSame('8801711000001', $order->customer_phone);
            $this->assertSame('rafi@example.com', $order->customer_email);
            $item = $order->items->first();
            $this->assertSame([70000, 'TSHIRT-1', 150000, true], [$item->unit_cost_amount, $item->sku, $item->compare_at_amount, $item->tracked]);
            $this->assertSame(2, Inventory::query()->where('variant_id', $variant)->value('committed'));
            $this->assertSame(5, Inventory::query()->where('variant_id', $variant)->value('on_hand'));
            $payment = Payment::query()->firstOrFail();
            $this->assertSame(['cod', 'charge', 'pending', 247000], [$payment->provider, $payment->type, $payment->status, $payment->amount]);
            $this->assertSame('placed', OrderEvent::query()->value('type'));
            $customer = Customer::query()->firstOrFail();
            $this->assertSame(['storefront', 1, 'Dhaka'], [$customer->source, $customer->orders_count, $customer->district]);
            $this->assertSame(Cart::CONVERTED, Cart::query()->value('status'));
            $this->assertSame($order->id, Cart::query()->value('converted_order_id'));
        });
        Queue::assertPushedOn('notifications', SendOrderSms::class);
        Queue::assertPushed(SendOrderMail::class, 2); // shopper (email given) + merchant
        $this->sf($store, 'GET', '/cart', [], $cart)->assertNotFound()->assertJsonPath('error.code', 'cart_not_found');
    }

    public function test_confirmation_token_shows_the_order_for_24_hours(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $token = $this->placeOrder($store, $variant)->json('data.confirmation_token');

        $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $token])->assertOk()
            ->assertJsonPath('data.number', 'SH-1001')->assertHeader('Cache-Control', 'no-store, private');
        $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => 'nope'])->assertNotFound();
        $this->travel(25)->hours();
        $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $token])->assertNotFound();
        $this->artisan('orders:expire-confirmation-tokens')->assertSuccessful();
        $this->assertNull(Order::withoutTenancy()->value('confirmation_token_hash'));
    }

    public function test_errors_of_section_3_4(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class); // many attempts with one phone; limits are tested in CommerceSecurityTest
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 2);
        $cart = $this->cartWith($store, $variant);
        $ok = $this->checkoutBody(107000);

        // 400 missing key
        $this->sf($store, 'POST', '/checkout', $ok, $cart)->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        // 404 no / unknown cart
        $this->checkout($store, str_repeat('a', 43), $ok)->assertNotFound()->assertJsonPath('error.code', 'cart_not_found');
        // 422 validation
        $this->checkout($store, $cart, $this->checkoutBody(107000, ['contact' => ['phone' => '12345']]))->assertStatus(422)
            ->assertJsonValidationErrors(['contact.phone'], 'error.details');
        $this->checkout($store, $cart, $this->checkoutBody(107000, ['shipping_address' => ['thana_code' => 'gazipur-kaliakair']]))->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['shipping_address.thana_code']]]);
        $this->checkout($store, $cart, $this->checkoutBody(107000, ['expected_total_amount' => 1070.5]))->assertStatus(422);
        // 422 payment method
        $this->checkout($store, $cart, $this->checkoutBody(107000, ['payment_method' => 'bkash']))->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
        $this->tenancy()->run($tenant, fn () => StoreSetting::query()->update(['cod_enabled' => false]));
        $this->checkout($store, $cart, $ok)->assertStatus(422)->assertJsonPath('error.code', 'payment_method_unavailable');
        $this->tenancy()->run($tenant, fn () => StoreSetting::query()->update(['cod_enabled' => true]));
        // 409 checkout_changed
        $this->checkout($store, $cart, $this->checkoutBody(100000))->assertStatus(409)->assertJsonPath('error.code', 'checkout_changed')
            ->assertJsonPath('error.details.expected_total_amount.0', 'The total changed to ৳ 1,070. Check your order and place it again.');
        // 422 out_of_stock (another order took the stock)
        $this->manual($h, $store, $this->manualBody($variant, 2))->assertCreated();
        $this->checkout($store, $cart, $ok)->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock')
            ->assertJsonPath('error.details', ['items.0.quantity' => ['This item is sold out.']]);
        // 422 cart_empty
        $item = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.lines.0.id');
        $this->sf($store, 'DELETE', "/cart/items/{$item}", [], $cart)->assertOk();
        $this->checkout($store, $cart, $ok)->assertStatus(422)->assertJsonPath('error.code', 'cart_empty');
        // nothing written by the failures: one (manual) order, one sequence value
        $this->assertSame(1, Order::withoutTenancy()->count());
    }

    #[Group('security')]
    public function test_draft_store_checkout_is_not_live(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $cart = $this->cartWith($store, $variant);
        $this->tenancy()->run($tenant, fn () => Store::query()->update(['status' => 'draft']));
        $this->checkout($store, $cart, $this->checkoutBody(107000))->assertStatus(409)->assertJsonPath('error.code', 'store_not_live')
            ->assertJsonPath('error.message', "Your shop isn't live yet. Orders open after you go live.");
    }

    public function test_order_numbers_use_prefix_and_leave_no_gap_on_rollback(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 50000, 10);
        $this->placeOrder($store, $variant)->assertJsonPath('data.order.number', 'SH-1001');
        $cart = $this->cartWith($store, $variant);
        $this->checkout($store, $cart, $this->checkoutBody(1))->assertStatus(409); // rolled back after commit + counter
        $this->tenancy()->run($tenant, fn () => StoreSetting::query()->update(['order_prefix' => 'GS']));
        $this->checkout($store, $cart, $this->checkoutBody(57000))->assertCreated()->assertJsonPath('data.order.number', 'GS-1002');
    }

    public function test_existing_customer_is_reused_and_only_empty_fields_filled(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $c = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'Rafi (VIP)', 'phone' => '01711000001'])->assertCreated()->json('data');
        $this->placeOrder($store, $variant, 1, ['contact' => ['name' => 'Someone Else', 'email' => 'rafi@example.com']]);
        $this->tenancy()->run($tenant, function () use ($c) {
            $customer = Customer::query()->findOrFail($c['id']);
            $this->assertSame(['Rafi (VIP)', 'rafi@example.com', 'manual', 1], [$customer->name, $customer->email, $customer->source, $customer->orders_count]);
            $this->assertSame(1, Customer::query()->count());
            $this->assertSame($c['id'], Order::query()->value('customer_id'));
        });
    }

    public function test_free_delivery_threshold_and_free_shipping_coupon(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 10);
        $settings = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipping")->json('data');
        $zones = array_map(fn ($z) => ['id' => $z['id'], 'name' => $z['name'], 'kind' => $z['kind'], 'charge_amount' => $z['charge_amount'],
            'min_days' => $z['min_days'], 'max_days' => $z['max_days'], 'areas' => array_map(fn ($a) => ['district_code' => $a['district_code'], 'thana_code' => $a['thana_code']], $z['areas'])], $settings['zones']);
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/shipping", ['zones' => $zones, 'free_delivery_over_amount' => 200000])->assertOk();

        $this->placeOrder($store, $variant, 1)->assertJsonPath('data.order.shipping_amount', 7000);
        $this->placeOrder($store, $variant, 2)->assertJsonPath('data.order.shipping_amount', 0)->assertJsonPath('data.order.total_amount', 200000);

        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'SHIPFREE', 'type' => 'free_shipping', 'status' => 'active'])->assertCreated();
        $r = $this->placeOrder($store, $variant, 1, ['contact' => ['phone' => '01711000009']], 'shipfree')
            ->assertJsonPath('data.order.shipping_amount', 0)->assertJsonPath('data.order.total_amount', 100000)->assertJsonPath('data.order.coupon_code', 'SHIPFREE');
        $this->tenancy()->run($tenant, function () use ($r) {
            $order = Order::query()->where('number', $r->json('data.order.number'))->firstOrFail();
            $this->assertSame(7000, $order->shipping_discount_amount);
            $this->assertSame(1, Coupon::query()->value('used_count'));
            $this->assertSame(7000, (int) \DB::table('coupon_redemptions')->value('discount_amount'));
        });
    }
}
