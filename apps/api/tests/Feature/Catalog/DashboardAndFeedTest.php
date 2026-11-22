<?php

namespace Tests\Feature\Catalog;

use App\Domain\Customers\Models\Customer;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class DashboardAndFeedTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        config(['storeplix.storefront_api_key' => 'test-storefront-key']);
    }

    public function test_dashboard_counts_staff_cost_and_month_boundary(): void
    {
        // Asia/Dhaka is UTC+6: 2026-11-30 19:00Z is already Dec 1 in Dhaka.
        Carbon::setTestNow('2026-11-30 19:00:00');
        [, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->createProduct($h, $store, ['name' => 'A', 'status' => 'active', 'variants' => [['price_amount' => 1000, 'cost_amount' => 400, 'initial_on_hand' => 3]]]);
        $this->createProduct($h, $store, ['name' => 'B', 'status' => 'active', 'variants' => [['price_amount' => 1000, 'initial_on_hand' => 0]]]);
        $this->createProduct($h, $store, $this->simpleProduct('Draft'));

        $this->tenancy()->run($tenant, function () use ($store) {
            foreach (['2026-11-30 17:59:00' => '01711111111', '2026-11-30 18:00:00' => '01722222222'] as $at => $phone) {
                $c = new Customer(['name' => 'C', 'phone' => '88'.$phone]);
                $c->store_id = $store->id;
                $c->created_at = Carbon::parse($at);
                $c->save();
            }
        });

        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/dashboard")->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('data.products', ['total' => 3, 'active' => 2, 'draft' => 1, 'archived' => 0, 'limit' => 1000])
            ->assertJsonPath('data.inventory', ['low_stock_variants' => 1, 'out_of_stock_variants' => 1, 'units_on_hand' => 3, 'stock_value_cost_amount' => 1200])
            ->assertJsonPath('data.customers', ['total' => 2, 'new_this_month' => 1])
            ->assertJsonPath('data.orders', null)->assertJsonPath('data.setup.has_products', true)
            ->assertJsonPath('data.timezone', 'Asia/Dhaka');
        $this->api($staffH, 'GET', "/api/v1/stores/{$store->id}/dashboard")->assertJsonPath('data.inventory.stock_value_cost_amount', null);
        Carbon::setTestNow();
    }

    public function test_feed_cards_filters_and_has_products(): void
    {
        Storage::fake('public');
        [, , $store, $h] = $this->shop();
        $host = $store->slug.'.storeplix.test';
        $this->storefront('/products', $host)->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.has_products', false);

        $women = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Women'])->json('data.id');
        $sarees = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Sarees', 'parent_id' => $women])->json('data.id');
        $img = $this->productImage($h);
        $this->createProduct($h, $store, [
            'name' => 'Saree', 'status' => 'active', 'category_ids' => [$sarees], 'images' => [['media_id' => $img]],
            'options' => [['name' => 'Size', 'values' => ['A', 'B', 'C']]],
            'variants' => [
                ['option_values' => ['A'], 'price_amount' => 5000, 'compare_at_amount' => 6000, 'cost_amount' => 1, 'sku' => 'SECRET'],
                ['option_values' => ['B'], 'price_amount' => 3000, 'is_enabled' => false],
                ['option_values' => ['C'], 'price_amount' => 4000],
            ],
        ]);
        $this->travel(1)->minutes();
        $this->createProduct($h, $store, ['name' => 'Sale tee', 'status' => 'active', 'variants' => [['price_amount' => 1000, 'compare_at_amount' => 1500]]]);
        $this->createProduct($h, $store, $this->simpleProduct('Draft hidden'));
        $this->createProduct($h, $store, ['name' => 'All disabled', 'status' => 'active', 'variants' => [['price_amount' => 1, 'is_enabled' => false]]]);

        $res = $this->storefront('/products?limit=10', $host)->assertOk()
            ->assertHeader('Cache-Control', 'max-age=0, public, s-maxage=60')->assertJsonPath('meta.has_products', true);
        $cards = $res->json('data');
        $this->assertSame(['Sale tee', 'Saree'], array_column($cards, 'name'));
        $this->assertSame(['id', 'slug', 'name', 'subtitle', 'price_amount', 'compare_at_amount', 'currency', 'on_sale', 'image'], array_keys($cards[1]));
        $this->assertSame(4000, $cards[1]['price_amount']); // cheapest ENABLED variant
        $this->assertFalse($cards[1]['on_sale']);
        $this->assertSame('Sarees', $cards[1]['subtitle']);
        $this->assertStringNotContainsString('SECRET', $res->getContent());
        $this->assertStringNotContainsString($store->id, $res->getContent());

        $this->storefront('/products?on_sale=1', $host)->assertJsonCount(1, 'data')->assertJsonPath('data.0.on_sale', true);
        $this->storefront('/products?category=women', $host)->assertJsonCount(1, 'data')->assertJsonPath('data.0.name', 'Saree');
        $this->storefront('/products?category=nope', $host)->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.has_products', true);
        $this->storefront('/products?limit=25', $host)->assertStatus(422);
    }

    #[Group('tenancy')]
    public function test_feed_draft_store_preview_and_isolation(): void
    {
        [, $tenantA, $storeA, $hA] = $this->shop();
        [, , $storeB, $hB] = $this->shop();
        $this->createProduct($hA, $storeA, ['name' => 'Only A', 'status' => 'active', 'variants' => [['price_amount' => 100]]]);
        $this->createProduct($hB, $storeB, ['name' => 'Only B', 'status' => 'active', 'variants' => [['price_amount' => 100]]]);
        $hostA = $storeA->slug.'.storeplix.test';
        $this->assertSame(['Only A'], array_column($this->storefront('/products', $hostA)->json('data'), 'name'));

        $this->tenancy()->run($tenantA, fn () => Store::query()->whereKey($storeA->id)->update(['status' => Store::STATUS_DRAFT]));
        $this->storefront('/products', $hostA)->assertNotFound()->assertJsonPath('error.code', 'store_not_found');
        $this->storefront('/products', $hostA, $this->previewToken($storeA))->assertOk()
            ->assertHeader('Cache-Control', 'no-store, private')->assertJsonPath('data.0.name', 'Only A');
        $this->storefront('/products', $hostA, $this->previewToken($storeB))->assertNotFound();
    }
}
