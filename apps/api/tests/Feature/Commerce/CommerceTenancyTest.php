<?php

namespace Tests\Feature\Commerce;

use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Coupons\Models\CouponRedemption;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Shared\Idempotency\IdempotencyKey;
use App\Domain\Shared\Models\StoreCounter;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Shipping\Models\ShippingZoneArea;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** §12 tenancy group for Phase 5a: model isolation, foreign route ids (404), foreign payload ids (422), storefront hosts. */
#[Group('tenancy')]
class CommerceTenancyTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    /** A full commerce footprint in one shop: zones, pickup, coupon, cart, orders (shipped + refunded), idempotency keys. */
    private function footprint(string $slug): array
    {
        [, $tenant, $store, $h] = $this->liveShop($slug);
        [$product, $variant] = $this->stocked($h, $store, 100000, 20);
        $category = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Cat '.$slug])->json('data');
        $coupon = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'C'.strtoupper($slug), 'type' => 'fixed', 'amount' => 1000, 'status' => 'active'])->json('data');
        $pickup = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/pickup-locations", ['name' => 'WH', 'district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur', 'address_line' => 'Road 1, House 2'])->json('data');
        $placed = $this->placeOrder($store, $variant, 1, ['contact' => ['phone' => '01711000777']], $coupon['code'])->json('data');
        $this->cartWith($store, $variant); // an open cart
        $order = $this->manual($h, $store, $this->manualBody($variant))->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}")->assertOk();
        }
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/refunds", ['amount' => 100, 'method' => 'cash'])->assertCreated();

        return compact('tenant', 'store', 'h', 'product', 'variant', 'category', 'coupon', 'pickup', 'order', 'placed');
    }

    public function test_models_are_isolated_by_tenant_and_store(): void
    {
        $a = $this->footprint('alpha');
        $b = $this->footprint('bravo');
        foreach ([ShippingZone::class, ShippingZoneArea::class, PickupLocation::class, Coupon::class, CouponRedemption::class, Cart::class, CartItem::class,
            Order::class, OrderItem::class, OrderEvent::class, Shipment::class, Payment::class, IdempotencyKey::class, StoreCounter::class] as $model) {
            $this->assertGreaterThan(0, $model::withoutTenancy()->where('tenant_id', $b['tenant']->id)->count(), "{$model} has no B rows");
            $this->assertStoreIsolation($model, $a['tenant'], $a['store'], $b['store']);
            $this->assertStoreIsolation($model, $b['tenant'], $b['store'], $a['store']);
        }
        // separate order sequences per store
        $this->assertSame('AL-1001', $a['placed']['order']['number']);
        $this->assertSame('BR-1001', $b['placed']['order']['number']);
    }

    public function test_foreign_route_ids_are_not_found(): void
    {
        $a = $this->footprint('alpha');
        $b = $this->footprint('bravo');
        $sA = $a['store']->id;
        $order = $b['order']['id'];
        $this->assertTenantIsolation($a['h'], [
            ['GET', "/api/v1/stores/{$sA}/orders/{$order}"],
            ['PATCH', "/api/v1/stores/{$sA}/orders/{$order}", ['revision' => 1]],
            ['POST', "/api/v1/stores/{$sA}/orders/{$order}/confirm"],
            ['POST', "/api/v1/stores/{$sA}/orders/{$order}/cancel", ['reason' => 'other']],
            ['POST', "/api/v1/stores/{$sA}/orders/{$order}/notes", ['body' => 'x']],
            ['GET', "/api/v1/stores/{$sA}/coupons/{$b['coupon']['id']}"],
            ['PATCH', "/api/v1/stores/{$sA}/coupons/{$b['coupon']['id']}", ['revision' => 1]],
            ['DELETE', "/api/v1/stores/{$sA}/coupons/{$b['coupon']['id']}"],
            ['PATCH', "/api/v1/stores/{$sA}/pickup-locations/{$b['pickup']['id']}", ['name' => 'x']],
            ['DELETE', "/api/v1/stores/{$sA}/pickup-locations/{$b['pickup']['id']}"],
            ['GET', "/api/v1/stores/{$b['store']->id}/orders"],
            ['GET', "/api/v1/stores/{$b['store']->id}/shipping"],
            ['GET', "/api/v1/stores/{$b['store']->id}/launch-checklist"],
            ['POST', "/api/v1/stores/{$b['store']->id}/publish"],
        ]);
        $this->api($a['h'] + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$sA}/orders/{$order}/refunds", ['amount' => 1, 'method' => 'cash'])->assertNotFound();
        $this->api($a['h'] + ['Idempotency-Key' => (string) Str::uuid()], 'POST', "/api/v1/stores/{$b['store']->id}/orders", $this->manualBody($a['variant']))->assertNotFound();
    }

    /** S6: B's ids inside A's payloads → 422 with the field path. */
    public function test_foreign_payload_ids_are_rejected(): void
    {
        $a = $this->footprint('alpha');
        $b = $this->footprint('bravo');
        $sA = $a['store'];
        $this->manual($a['h'], $sA, $this->manualBody($b['variant']))->assertStatus(422)->assertJsonPath('error.details', ['items.0.variant_id' => ['Unknown variant.']]);
        $customerB = Order::withoutTenancy()->where('id', $b['order']['id'])->value('customer_id');
        $this->manual($a['h'], $sA, $this->manualBody($a['variant'], 1, ['customer_id' => $customerB]))->assertStatus(422)->assertJsonPath('error.details', ['customer_id' => ['Unknown customer.']]);
        $this->manual($a['h'], $sA, $this->manualBody($a['variant'], 1, ['coupon_code' => $b['coupon']['code']]))->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid');
        $url = "/api/v1/stores/{$sA->id}/coupons";
        $this->api($a['h'], 'POST', $url, ['code' => 'XCAT', 'type' => 'fixed', 'amount' => 1, 'applies_to' => 'categories', 'category_ids' => [$b['category']['id']]])->assertStatus(422)
            ->assertJsonPath('error.details', ['category_ids.0' => ['Unknown category.']]);
        $this->api($a['h'], 'POST', $url, ['code' => 'XPRD', 'type' => 'fixed', 'amount' => 1, 'applies_to' => 'products', 'product_ids' => [$b['product']['id']]])->assertStatus(422)
            ->assertJsonPath('error.details', ['product_ids.0' => ['Unknown product.']]);
        $this->api($a['h'], 'POST', "/api/v1/stores/{$sA->id}/orders/bulk", ['action' => 'confirm', 'ids' => [$b['order']['id']]])->assertStatus(422)
            ->assertJsonPath('error.details', ['ids.0' => ['Unknown order.']]);
        $this->api($a['h'], 'GET', "/api/v1/stores/{$sA->id}/orders?filter[customer_id]={$customerB}")->assertJsonPath('meta.total', 0);
        $this->api($a['h'], 'POST', "/api/v1/stores/{$sA->id}/orders/quote", $this->manualBody($b['variant']))->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')->assertJsonPath('error.details', ['items.0.variant_id' => ['Unknown variant.']]);
        $two = $this->manualBody($a['variant']);
        $two['items'][] = ['variant_id' => $b['variant'], 'quantity' => 1];
        $this->api($a['h'], 'POST', "/api/v1/stores/{$sA->id}/orders/quote", $two)->assertStatus(422)
            ->assertJsonPath('error.details', ['items.1.variant_id' => ['Unknown variant.']]);
        // storefront: B's variant on A's host
        $this->sf($sA, 'POST', '/cart/items', ['variant_id' => $b['variant'], 'quantity' => 1])->assertStatus(422)->assertJsonPath('error.details.variant_id.0', "This item isn't available.");
    }

    public function test_storefront_host_never_returns_another_stores_data(): void
    {
        $a = $this->footprint('alpha');
        $b = $this->footprint('bravo');
        $this->sf($a['store'], 'GET', "/products/{$b['product']['slug']}")->assertNotFound();
        $this->sf($a['store'], 'GET', "/products/{$b['product']['slug']}/availability")->assertNotFound();
        $this->sf($a['store'], 'GET', '/categories/'.$b['category']['slug'])->assertNotFound();
        $ids = array_column($this->sf($a['store'], 'GET', '/products?page=1')->json('data'), 'id');
        $this->assertNotContains($b['product']['id'], $ids);
        $this->sf($a['store'], 'POST', '/orders/track', ['number' => $b['placed']['order']['number'], 'phone' => '01711000777'])->assertNotFound();
        $this->sf($a['store'], 'POST', '/orders/track', ['number' => '1001', 'phone' => '01711000777'])->assertOk()
            ->assertJsonPath('data.number', $a['placed']['order']['number']);
        $this->sf($a['store'], 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $b['placed']['confirmation_token']])->assertNotFound();
        $this->sf($b['store'], 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $b['placed']['confirmation_token']])->assertOk();
    }
}
