<?php

namespace Tests\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/** Phase 5a helpers: a live shop with stock and delivery zones, storefront calls with a cart, checkout payloads. */
trait CommerceFixtures
{
    use CatalogFixtures;

    /** @return array{0: User, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function liveShop(string $slug = 'shop'): array
    {
        [$user, $tenant, $store, $h] = $this->shop(slug: $slug);
        $this->tenancy()->run($tenant, function () use ($store) {
            app(ShippingService::class)->provisionDefaults($store);
            StoreSetting::query()->where('store_id', $store->id)->update(['contact_phone' => '+8801700000001', 'contact_email' => 'shop@example.test']);
        });

        return [$user, $tenant, $store, $h];
    }

    /** Active simple product; returns [product payload, variant id]. @return array{0: array<string, mixed>, 1: string} */
    protected function stocked(array $h, Store $store, int $price = 100000, int $stock = 10, array $variant = [], array $extra = []): array
    {
        $p = $this->createProduct($h, $store, $this->simpleProduct('Item '.Str::random(5), $price, ['status' => 'active'] + $extra, ['initial_on_hand' => $stock] + $variant));

        return [$p, $p['variants'][0]['id']];
    }

    protected function host(Store $store): string
    {
        return $store->slug.'.storeplix.test';
    }

    /** @param array<string, string|null> $extra */
    protected function sf(Store $store, string $method, string $path, array $body = [], ?string $cart = null, array $extra = []): TestResponse
    {
        $headers = array_filter(array_merge([
            'X-Storefront-Key' => 'test-storefront-key',
            'X-Storefront-Host' => $this->host($store),
            'X-Cart-Token' => $cart,
            'X-Storefront-Client-Ip' => '203.0.113.'.random_int(1, 250),
        ], $extra), fn ($v) => $v !== null);

        return $this->flushHeaders()->withHeaders($headers)->json($method, '/api/v1/storefront'.$path, $body);
    }

    /** Adds to a (new) cart and returns the cart token. */
    protected function cartWith(Store $store, string $variantId, int $quantity = 1, ?string $token = null): string
    {
        $r = $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variantId, 'quantity' => $quantity], $token);
        $r->assertSuccessful();

        return $token ?? $r->json('meta.cart_token');
    }

    /** @return array<string, mixed> CheckoutInput */
    protected function checkoutBody(int $expected, array $override = []): array
    {
        return array_replace_recursive([
            'contact' => ['name' => 'Rafi Ahmed', 'phone' => '01711000001', 'email' => null],
            'shipping_address' => ['district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'House 12, Road 7A', 'area' => 'Road 7A area'],
            'payment_method' => 'cod',
            'expected_total_amount' => $expected,
        ], $override);
    }

    protected function checkout(Store $store, string $cart, array $body, ?string $key = null, array $extra = []): TestResponse
    {
        return $this->sf($store, 'POST', '/checkout', $body, $cart, ['Idempotency-Key' => $key ?? (string) Str::uuid()] + $extra);
    }

    /** Cart → checkout at the cart's total + the Dhaka city delivery charge (7000). Returns the 201 response. */
    protected function placeOrder(Store $store, string $variantId, int $quantity = 1, array $override = [], ?string $coupon = null): TestResponse
    {
        $cart = $this->cartWith($store, $variantId, $quantity);
        if ($coupon !== null) {
            $this->sf($store, 'PUT', '/cart/coupon', ['code' => $coupon], $cart)->assertOk();
        }
        $total = $this->sf($store, 'GET', '/cart', [], $cart)->json('data.estimated_total_amount');
        $address = $override['shipping_address'] ?? ['district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi'];
        $shipping = $this->sf($store, 'GET', '/cart/shipping-options?district_code='.$address['district_code'].'&thana_code='.$address['thana_code'], [], $cart)->json('data.amount');

        return $this->checkout($store, $cart, $this->checkoutBody($total + $shipping, $override))->assertCreated();
    }

    /** @return array<string, mixed> ManualOrderInput */
    protected function manualBody(string $variantId, int $quantity = 1, array $override = []): array
    {
        return array_replace_recursive([
            'items' => [['variant_id' => $variantId, 'quantity' => $quantity]],
            'channel' => 'facebook',
            'contact' => ['name' => 'Nusrat Jahan', 'phone' => '01811223344'],
            'shipping_address' => ['district_code' => 'gazipur', 'thana_code' => 'gazipur-kaliakair', 'address_line' => 'Holding 4, Bazar Road'],
        ], $override);
    }

    protected function manual(array $h, Store $store, array $body, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', "/api/v1/stores/{$store->id}/orders", $body);
    }
}
