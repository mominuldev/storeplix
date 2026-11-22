<?php

namespace Tests\Feature\Commerce;

use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** §3.2 storefront catalog (P5-6, P5-28, P5-30) and §12 "Catalog storefront" incl. exact key sets (S7) and S16. */
class StorefrontCatalogTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, StorefrontContent;

    private const FORBIDDEN = ['cost_amount', 'sku', 'barcode', 'on_hand', 'committed', 'tenant_id', 'store_id', 'revision', 'created_by', 'unit_cost_amount'];

    /** Recursively: no forbidden key anywhere in the payload. */
    private function assertNoLeaks(array $payload, string $where): void
    {
        array_walk_recursive($payload, fn () => null);
        $walk = function ($value, string $path) use (&$walk, $where) {
            if (! is_array($value)) {
                return;
            }
            foreach ($value as $key => $child) {
                $this->assertNotContains((string) $key, self::FORBIDDEN, "{$where}: {$path}.{$key} leaks");
                $walk($child, "{$path}.{$key}");
            }
        };
        $walk($payload, '');
    }

    public function test_pdp_exact_keys_variants_and_preview(): void
    {
        Storage::fake('public');
        [$user, $tenant, $store, $h] = $this->liveShop();
        $media = $this->productImage($h);
        $p = $this->createProduct($h, $store, $this->variableProduct('Jamdani Three-Piece', ['M', 'L'], ['Red']) + [
            'images' => [['media_id' => $media, 'alt' => 'Front']], 'seo' => ['title' => 'Jamdani'],
        ]);
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$p['id']}", ['revision' => 1, 'variants' => [
            ['id' => $p['variants'][0]['id'], 'option_values' => ['M', 'Red'], 'price_amount' => 345000, 'cost_amount' => 1, 'is_enabled' => false],
            ['id' => $p['variants'][1]['id'], 'option_values' => ['L', 'Red'], 'price_amount' => 355000, 'compare_at_amount' => 400000],
        ]])->assertOk();

        $res = $this->sf($store, 'GET', "/products/{$p['slug']}")->assertOk()
            ->assertHeader('Cache-Control', 'max-age=0, public, s-maxage=60')
            ->assertJsonPath('data.price_min_amount', 355000)->assertJsonPath('data.url_path', "/products/{$p['slug']}")
            ->assertJsonPath('data.is_preview_only', false)->assertJsonCount(1, 'data.variants')
            ->assertJsonPath('data.variants.0.option_values', ['L', 'Red'])->assertJsonPath('data.variants.0.compare_at_amount', 400000)
            ->assertJsonPath('data.images.0.alt', 'Front')->assertJsonPath('data.seo.title', 'Jamdani');
        $this->assertSame(['id', 'slug', 'name', 'description', 'options', 'variants', 'images', 'price_min_amount', 'price_max_amount', 'currency', 'categories', 'seo', 'url_path', 'is_preview_only', 'updated_at'], array_keys($res->json('data')));
        $this->assertSame(['id', 'title', 'option_values', 'price_amount', 'compare_at_amount', 'image_media_id'], array_keys($res->json('data.variants.0')));
        $this->assertNoLeaks($res->json(), 'pdp');

        $draft = $this->createProduct($h, $store, $this->simpleProduct('Secret draft'));
        $this->sf($store, 'GET', "/products/{$draft['slug']}")->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->sf($store, 'GET', '/products/no-such-thing')->assertNotFound();
        $token = $this->previewToken($store);
        $this->sf($store, 'GET', "/products/{$draft['slug']}", [], null, ['X-Storefront-Preview' => $token])->assertOk()
            ->assertJsonPath('data.is_preview_only', true)->assertHeader('Cache-Control', 'no-store, private');
    }

    public function test_availability_rules(): void
    {
        [, , $store, $h] = $this->liveShop();
        [$low] = $this->stocked($h, $store, 1000, 4);
        [$plenty] = $this->stocked($h, $store, 1000, 40);
        [$untracked] = $this->stocked($h, $store, 1000, 0, ['track_inventory' => false]);
        [$backorder] = $this->stocked($h, $store, 1000, 0, ['allow_backorder' => true]);
        [$out] = $this->stocked($h, $store, 1000, 0);
        [$custom] = $this->stocked($h, $store, 1000, 8, ['low_stock_threshold' => 10]);
        $check = fn (array $p, bool $available, ?int $low) => $this->sf($store, 'GET', "/products/{$p['slug']}/availability")->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertExactJson(['data' => ['variants' => [['id' => $p['variants'][0]['id'], 'available' => $available, 'low_stock' => $low]]]]);
        $check($low, true, 4);
        $check($plenty, true, null);
        $check($untracked, true, null);
        $check($backorder, true, null);
        $check($out, false, null);
        $check($custom, true, 8);
        // committed stock counts: an order of 3 leaves 1
        $this->placeOrder($store, $low['variants'][0]['id'], 3);
        $check($low, true, 1);
    }

    public function test_plp_pagination_filters_sorts_and_card_keys(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        [, , $store, $h] = $this->liveShop();
        $cat = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Sarees'])->assertCreated()->json('data');
        $child = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Jamdani', 'parent_id' => $cat['id']])->assertCreated()->json('data');
        $made = [];
        foreach ([[1000, 5, []], [3000, 0, []], [2000, 5, ['category_ids' => [$child['id']]]], [5000, 5, ['category_ids' => [$cat['id']], 'tags' => ['silk']]]] as $i => [$price, $stock, $extra]) {
            $made[] = $this->stocked($h, $store, $price, $stock, [], $extra);
            $this->travel(1)->minutes();
        }

        $page = $this->sf($store, 'GET', '/products?page=1&per_page=2')->assertOk()
            ->assertJsonPath('meta.total', 4)->assertJsonPath('meta.last_page', 2)->assertJsonPath('meta.current_page', 1)->assertJsonPath('meta.has_products', true)
            ->assertJsonCount(2, 'data');
        $this->assertSame(['id', 'slug', 'name', 'subtitle', 'price_amount', 'compare_at_amount', 'currency', 'on_sale', 'image'], array_keys($page->json('data.0')));
        $this->assertNoLeaks($page->json(), 'cards');
        $this->sf($store, 'GET', '/products?page=1&limit=2')->assertStatus(422);
        $this->sf($store, 'GET', '/products?per_page=49')->assertStatus(422);

        $names = fn (string $q) => array_column($this->sf($store, 'GET', '/products?'.$q)->assertOk()->json('data'), 'price_amount');
        $this->assertSame([1000, 2000, 3000, 5000], $names('sort=price_asc&page=1'));
        $this->assertSame([5000, 3000, 2000, 1000], $names('sort=price_desc&page=1'));
        $this->assertSame([2000, 3000], $names('sort=price_asc&page=1&price_min=1500&price_max=3000'));
        $this->assertSame([1000, 2000, 5000], $names('sort=price_asc&page=1&in_stock=1'));
        $this->assertSame([2000, 5000], $names('sort=price_asc&page=1&category='.$cat['slug'])); // includes descendants
        $this->assertSame([5000], $names('page=1&q=silk'));
        $this->assertSame([5000, 2000, 1000], $names('page=1&exclude='.$made[1][0]['id']));
        $this->assertSame([], $names('page=1&category=nope'));

        // bestsellers (P5-30): units in non-cancelled orders of the last 30 days, then latest
        $this->placeOrder($store, $made[0][1], 3);
        $this->placeOrder($store, $made[2][1], 1);
        $this->assertSame([1000, 2000, 5000, 3000], $names('sort=bestsellers&page=1'));
    }

    public function test_categories_tree_and_detail(): void
    {
        [, , $store, $h] = $this->liveShop();
        $root = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Clothing'])->json('data');
        $kid = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Boys', 'parent_id' => $root['id'], 'description' => 'For boys'])->json('data');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Hidden', 'parent_id' => $root['id'], 'is_visible' => false])->assertCreated();
        $res = $this->sf($store, 'GET', '/categories')->assertOk()
            ->assertJsonPath('data.0.slug', 'clothing')->assertJsonPath('data.0.url_path', '/c/clothing')
            ->assertJsonCount(1, 'data.0.children')->assertJsonPath('data.0.children.0.name', 'Boys');
        $this->assertSame(['slug', 'name', 'image', 'url_path', 'children'], array_keys($res->json('data.0')));
        $this->sf($store, 'GET', "/categories/{$kid['slug']}")->assertOk()->assertJsonPath('data.ancestors', [['slug' => 'clothing', 'name' => 'Clothing']])
            ->assertJsonPath('data.description', 'For boys');
        $this->sf($store, 'GET', '/categories/clothing')->assertJsonPath('data.children', [['slug' => 'boys', 'name' => 'Boys', 'url_path' => '/c/boys']]);
        $this->sf($store, 'GET', '/categories/hidden')->assertOk(); // hidden still resolves by slug
        $this->sf($store, 'GET', '/categories/nope')->assertNotFound();
    }

    /** S16: a draft store is Coming soon for the public; preview sees the catalog with no-store. */
    #[Group('security')]
    public function test_draft_store_catalog_is_not_found_without_preview(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [$p, $variant] = $this->stocked($h, $store);
        $this->tenancy()->run($tenant, fn () => Store::query()->update(['status' => 'draft']));
        foreach (["/products/{$p['slug']}", "/products/{$p['slug']}/availability", '/categories', '/products?page=1', '/categories/x'] as $path) {
            $this->sf($store, 'GET', $path)->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        }
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 1])->assertNotFound();
        $preview = ['X-Storefront-Preview' => $this->previewToken($store)];
        $this->sf($store, 'GET', "/products/{$p['slug']}", [], null, $preview)->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 1], null, $preview)->assertCreated();
        $this->sf($store, 'GET', '/config')->assertJsonPath('data.commerce.checkout_enabled', false)
            ->assertJsonPath('data.commerce.payment_methods', ['cod'])
            ->assertJsonPath('data.commerce.delivery', [
                ['name' => 'Inside Dhaka', 'charge_amount' => 7000, 'min_days' => 1, 'max_days' => 2],
                ['name' => 'Outside Dhaka', 'charge_amount' => 13000, 'min_days' => 2, 'max_days' => 4],
            ]);
    }

    /** S7: cart and order payloads never carry cost, SKU, barcode or exact stock. */
    #[Group('security')]
    public function test_cart_and_storefront_order_payloads_do_not_leak(): void
    {
        [, , $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50, ['cost_amount' => 400, 'sku' => 'SKU-LEAK', 'barcode' => '12345']);
        $cart = $this->cartWith($store, $variant, 2);
        $cartJson = $this->sf($store, 'GET', '/cart', [], $cart)->json();
        $this->assertNoLeaks($cartJson, 'cart');
        $this->assertSame(['id', 'variant_id', 'product_slug', 'product_name', 'variant_title', 'option_values', 'image', 'quantity', 'unit_price_amount', 'compare_at_amount', 'line_amount', 'issue', 'max_quantity', 'low_stock'], array_keys($cartJson['data']['lines'][0]));
        $this->assertNull($cartJson['data']['lines'][0]['low_stock']); // 50 in stock: no exact count
        $this->assertStringNotContainsString('SKU-LEAK', json_encode($cartJson));

        $order = $this->placeOrder($store, $variant, 1)->json();
        $this->assertNoLeaks($order, 'checkout');
        $this->assertStringNotContainsString('SKU-LEAK', json_encode($order));
        $track = $this->sf($store, 'POST', '/orders/track', ['number' => $order['data']['order']['number'], 'phone' => '01711000001'])->assertOk()->json();
        $this->assertNoLeaks($track, 'track');
        $this->assertSame(['number', 'status', 'placed_at', 'shipping', 'lines', 'total_amount', 'due_amount', 'currency', 'timeline', 'shipment'], array_keys($track['data']));
        $this->assertStringNotContainsString('House 12', json_encode($track));
        $this->assertStringNotContainsString('8801711000001', json_encode($track));
    }
}
