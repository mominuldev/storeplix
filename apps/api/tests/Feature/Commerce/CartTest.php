<?php

namespace Tests\Feature\Commerce;

use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Catalog\Models\ProductVariant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.3 cart (P5-3, P5-4) and §12 "Cart". */
class CartTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_first_add_creates_a_cart_and_returns_the_token_once(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 120000, 10);

        $created = $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 2])->assertCreated()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('data.lines_count', 1)->assertJsonPath('data.items_count', 2)
            ->assertJsonPath('data.subtotal_amount', 240000)->assertJsonPath('data.can_checkout', true);
        $token = $created->json('meta.cart_token');
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_-]{43}$/', $token);

        $again = $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 3], $token)->assertOk()
            ->assertJsonPath('data.lines.0.quantity', 5);
        $this->assertNull($again->json('meta.cart_token'));

        $this->tenancy()->run($tenant, function () use ($token) {
            $cart = Cart::query()->firstOrFail();
            $this->assertSame(hash('sha256', $token), $cart->token_hash);
            $this->assertFalse(DB::table('carts')->where('token_hash', $token)->exists());
        });
    }

    public function test_quantity_caps_lines_and_stock(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $untracked] = $this->stocked($h, $store, 1000, 0, ['track_inventory' => false]);
        [, $limited] = $this->stocked($h, $store, 1000, 3);
        $token = $this->cartWith($store, $untracked, 60);
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $untracked, 'quantity' => 60], $token)->assertOk()->assertJsonPath('data.lines.0.quantity', 99);
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $untracked, 'quantity' => 100], $token)->assertStatus(422);
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $limited, 'quantity' => 4], $token)->assertStatus(422)
            ->assertJsonPath('error.code', 'out_of_stock')->assertJsonPath('error.details.quantity.0', 'Only 3 left.');
        $line = $this->sf($store, 'POST', '/cart/items', ['variant_id' => $limited, 'quantity' => 3], $token)->assertOk()->json('data.lines.1');
        $this->assertSame(3, $line['low_stock']);
        $this->sf($store, 'PATCH', "/cart/items/{$line['id']}", ['quantity' => 4], $token)->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock');

        // 50 lines max
        $this->tenancy()->run($tenant, function () use ($store, $token) {
            $cart = Cart::query()->where('token_hash', hash('sha256', $token))->firstOrFail();
            $variantIds = ProductVariant::query()->pluck('id')->all();
            for ($i = count($variantIds); $i < 50; $i++) {
                $v = ProductVariant::query()->firstOrFail()->replicate(['sku']);
                $v->option1 = 'x'.$i;
                $v->save();
                $item = new CartItem;
                $item->store_id = $store->id;
                $item->cart_id = $cart->id;
                $item->variant_id = $v->id;
                $item->quantity = 1;
                $item->save();
            }
        });
        [, $another] = $this->stocked($h, $store, 1000, 5);
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $another, 'quantity' => 1], $token)->assertStatus(422)
            ->assertJsonPath('error.details.lines.0', 'Your bag can hold 50 different items.');
    }

    public function test_unavailable_variants_and_issue_lines(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [$p, $variant] = $this->stocked($h, $store, 1000, 5);
        $draft = $this->createProduct($h, $store, $this->simpleProduct('Draft', 1000))['variants'][0]['id'];
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $draft, 'quantity' => 1])->assertStatus(422)
            ->assertJsonPath('error.details.variant_id.0', "This item isn't available.");
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'quantity' => 1])->assertStatus(422);
        $this->assertSame(0, Cart::withoutTenancy()->count()); // a failed add never creates a cart

        $token = $this->cartWith($store, $variant, 5);
        // stock drops below the line quantity → insufficient_stock with max_quantity; checkout blocked
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments", ['reason' => 'lost', 'items' => [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 2]]])->assertOk();
        $this->sf($store, 'GET', '/cart', [], $token)->assertJsonPath('data.lines.0.issue', 'insufficient_stock')
            ->assertJsonPath('data.lines.0.max_quantity', 2)->assertJsonPath('data.subtotal_amount', 0)->assertJsonPath('data.can_checkout', false);
        // price change reflected on read; product archived → unavailable
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$p['id']}", ['revision' => 1, 'status' => 'archived'])->assertOk();
        $this->sf($store, 'GET', '/cart', [], $token)->assertJsonPath('data.lines.0.issue', 'unavailable');
    }

    public function test_prices_are_recomputed_on_every_read(): void
    {
        [, , $store, $h] = $this->liveShop();
        [$p, $variant] = $this->stocked($h, $store, 1000, 5, ['compare_at_amount' => 1500]);
        $token = $this->cartWith($store, $variant, 2);
        $this->sf($store, 'GET', '/cart', [], $token)->assertJsonPath('data.savings_amount', 1000)->assertJsonPath('data.lines.0.compare_at_amount', 1500);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$p['id']}", ['revision' => 1, 'variants' => [['id' => $variant, 'price_amount' => 1200, 'compare_at_amount' => null]]])->assertOk();
        $this->sf($store, 'GET', '/cart', [], $token)->assertJsonPath('data.subtotal_amount', 2400)->assertJsonPath('data.savings_amount', 0);
    }

    public function test_coupon_apply_remove_and_auto_removal_notice(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'WINTER15', 'type' => 'percentage', 'percent_bps' => 1500, 'max_discount_amount' => 20000, 'status' => 'active', 'min_subtotal_amount' => 150000])->assertCreated();
        $token = $this->cartWith($store, $variant, 1);
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'nope'], $token)->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid')
            ->assertJsonPath('error.details.code.0', "This code doesn't exist.");
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'winter15'], $token)->assertStatus(422)
            ->assertJsonPath('error.details.code.0', 'Spend ৳ 1,500 or more to use this code.');
        $item = $this->sf($store, 'GET', '/cart', [], $token)->json('data.lines.0.id');
        $this->sf($store, 'PATCH', "/cart/items/{$item}", ['quantity' => 2], $token)->assertOk();
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'winter15'], $token)->assertOk()
            ->assertJsonPath('data.coupon.code', 'WINTER15')->assertJsonPath('data.discount_amount', 20000) // 15 % of 2 000 = 300 → cap 200
            ->assertJsonPath('data.estimated_total_amount', 180000)->assertJsonPath('data.savings_amount', 20000);
        $this->sf($store, 'PATCH', "/cart/items/{$item}", ['quantity' => 1], $token)->assertOk()
            ->assertJsonPath('data.coupon', null)
            ->assertJsonPath('meta.notices.0', 'Code WINTER15 was removed: Spend ৳ 1,500 or more to use this code.');
        $this->sf($store, 'PATCH', "/cart/items/{$item}", ['quantity' => 2], $token)->assertOk();
        $this->sf($store, 'PUT', '/cart/coupon', ['code' => 'WINTER15'], $token)->assertOk();
        $this->sf($store, 'DELETE', '/cart/coupon', [], $token)->assertOk()->assertJsonPath('data.coupon', null);
    }

    public function test_shipping_quote_and_free_delivery_progress(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5);
        $token = $this->cartWith($store, $variant);
        $this->sf($store, 'GET', '/cart/shipping-options?district_code=dhaka&thana_code=dhaka-mirpur', [], $token)->assertOk()
            ->assertJsonPath('data.zone_name', 'Inside Dhaka')->assertJsonPath('data.amount', 7000)->assertJsonPath('data.is_free', false);
        $this->sf($store, 'GET', '/cart/shipping-options?district_code=sylhet&thana_code=sylhet-sylhet-sadar', [], $token)->assertOk()
            ->assertJsonPath('data.zone_name', 'Outside Dhaka')->assertJsonPath('data.amount', 13000);
        $this->sf($store, 'GET', '/cart/shipping-options?district_code=dhaka&thana_code=nope', [], $token)->assertStatus(422);
        $this->sf($store, 'GET', '/cart', [], $token)->assertJsonPath('data.free_delivery', null);
    }

    public function test_cart_of_another_store_is_not_found_and_prune(): void
    {
        [, , $storeA, $hA] = $this->liveShop('alpha');
        [, , $storeB] = $this->liveShop('bravo');
        [, $variant] = $this->stocked($hA, $storeA);
        $token = $this->cartWith($storeA, $variant);
        $this->sf($storeB, 'GET', '/cart', [], $token)->assertNotFound()->assertJsonPath('error.code', 'cart_not_found');
        $this->sf($storeB, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 1], $token)->assertStatus(422);

        $this->travel(31)->days();
        $this->sf($storeA, 'GET', '/cart', [], $token)->assertNotFound();
        $this->artisan('carts:prune')->assertSuccessful();
        $this->assertSame(Cart::ABANDONED, Cart::withoutTenancy()->value('status'));
        $this->travel(91)->days();
        $this->artisan('carts:prune')->assertSuccessful();
        $this->assertSame(0, Cart::withoutTenancy()->count());
    }
}
