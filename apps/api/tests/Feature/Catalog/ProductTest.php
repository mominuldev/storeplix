<?php

namespace Tests\Feature\Catalog;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

class ProductTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public function test_create_simple_and_variable_products(): void
    {
        [$user, , $store, $h] = $this->shop();

        $simple = $this->createProduct($h, $store, $this->simpleProduct(variant: ['sku' => 'PJ-1', 'cost_amount' => 90000, 'initial_on_hand' => 7]));
        $this->assertSame('simple', $simple['type']);
        $this->assertSame('draft', $simple['status']);
        $this->assertNull($simple['published_at']);
        $this->assertSame('cotton-panjabi', $simple['slug']);
        $this->assertSame('Default', $simple['variants'][0]['title']);
        $this->assertTrue($simple['variants'][0]['is_default']);
        $this->assertSame([], $simple['variants'][0]['option_values']);
        $this->assertSame(7, $simple['variants'][0]['inventory']['on_hand']);
        $this->assertSame('in_stock', $simple['variants'][0]['inventory']['status']);
        $this->assertSame(90000, $simple['cost_amount']);
        $this->assertSame('BDT', $simple['currency']);
        $this->assertSame(1, $simple['revision']);
        $this->assertSame($user->id, $simple['created_by']['id']);

        $variable = $this->createProduct($h, $store, $this->variableProduct(sizes: ['S', 'M', 'L'], colours: ['Red', 'Blue']));
        $this->assertSame('variable', $variable['type']);
        $this->assertCount(6, $variable['variants']);
        $this->assertSame('S / Red', $variable['variants'][0]['title']);
        $this->assertNotNull($variable['published_at']);
        $this->assertSame(345000, $variable['price_min_amount']);
        $this->assertSame(6, InventoryMovement::withoutTenancy()->where('reason', 'initial')->whereIn('variant_id', array_column($variable['variants'], 'id'))->count());
        $this->assertTrue(AuditLog::query()->where('action', 'product.created')->exists());
    }

    public function test_option_rules(): void
    {
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/products";
        $base = $this->variableProduct();

        $four = $base;
        $four['options'] = [['name' => 'A', 'values' => ['1']], ['name' => 'B', 'values' => ['1']], ['name' => 'C', 'values' => ['1']], ['name' => 'D', 'values' => ['1']]];
        $this->api($h, 'POST', $url, $four)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['options']]]);

        $many = $base;
        $many['options'][0]['values'] = array_map(fn ($i) => "V{$i}", range(1, 21));
        $this->api($h, 'POST', $url, $many)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['options.0.values']]]);

        $dup = $base;
        $dup['variants'][1]['option_values'] = ['M', 'Red'];
        $this->api($h, 'POST', $url, $dup)->assertStatus(422)->assertJsonPath('error.details', ['variants.1.option_values' => ['This combination already exists.']]);

        $wrong = $base;
        $wrong['variants'][0]['option_values'] = ['XXL', 'Red'];
        $this->api($h, 'POST', $url, $wrong)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['variants.0.option_values.0']]]);

        $this->api($h, 'POST', $url, ['name' => 'Two simple', 'variants' => [['price_amount' => 1], ['price_amount' => 2]]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['variants']]]);
    }

    public function test_sku_uniqueness_is_case_insensitive_and_freed_by_delete(): void
    {
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/products";
        $first = $this->createProduct($h, $store, $this->simpleProduct(variant: ['sku' => 'ABC-1']));

        $this->api($h, 'POST', $url, $this->simpleProduct('Other', variant: ['sku' => 'abc-1']))
            ->assertStatus(422)->assertJsonPath('error.details', ['variants.0.sku' => ['This SKU is already used by another product.']]);

        $payload = $this->variableProduct(skuPrefix: 'X');
        $payload['variants'][1]['sku'] = strtolower($payload['variants'][0]['sku']);
        $this->api($h, 'POST', $url, $payload)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['variants.1.sku']]]);

        $this->api($h, 'POST', $url, $this->simpleProduct('Bad sku', variant: ['sku' => '-bad sku']))->assertStatus(422);

        $this->api($h, 'DELETE', "{$url}/{$first['id']}")->assertNoContent();
        $this->createProduct($h, $store, $this->simpleProduct('Reuse', variant: ['sku' => 'ABC-1']));
    }

    public function test_money_rules(): void
    {
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/products";
        $this->api($h, 'POST', $url, $this->simpleProduct(variant: ['compare_at_amount' => 150000]))
            ->assertStatus(422)->assertJsonPath('error.details', ['variants.0.compare_at_amount' => ['Compare-at price must be higher than the price.']]);
        $this->api($h, 'POST', $url, ['name' => 'Float', 'variants' => [['price_amount' => 3450.5]]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['variants.0.price_amount']]]);
        $this->api($h, 'POST', $url, ['name' => 'String', 'variants' => [['price_amount' => '3450']]])->assertStatus(422);
        $this->api($h, 'POST', $url, ['name' => 'Huge', 'variants' => [['price_amount' => 1_000_000_001]]])->assertStatus(422);
    }

    public function test_images_order_limits_and_variant_image(): void
    {
        Storage::fake('public');
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/products";
        $a = $this->productImage($h);
        $b = $this->productImage($h);
        $page = $this->productImage($h, 'page_image');

        $product = $this->createProduct($h, $store, $this->simpleProduct(extra: ['images' => [['media_id' => $b, 'alt' => 'Back'], ['media_id' => $a]]], variant: ['image_media_id' => $a]));
        $this->assertSame([$b, $a], array_column($product['images'], 'media_id'));
        $this->assertSame($b, $product['image']['id']);
        $this->assertSame($a, $product['variants'][0]['image_media_id']);

        $this->api($h, 'POST', $url, $this->simpleProduct(extra: ['images' => [['media_id' => $page]]]))
            ->assertStatus(422)->assertJsonPath('error.details', ['images.0.media_id' => ['Unknown image.']]);
        $this->api($h, 'POST', $url, $this->simpleProduct(extra: ['images' => array_fill(0, 11, ['media_id' => $a])]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->simpleProduct(extra: ['images' => [['media_id' => $a]]], variant: ['image_media_id' => $b]))
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['variants.0.image_media_id']]]);

        // Removing the image nulls the variant reference; the media is in use while attached.
        $this->api($h, 'DELETE', "/api/v1/media/{$b}")->assertStatus(409);
        $this->api($h, 'PATCH', "{$url}/{$product['id']}", ['revision' => 1, 'images' => [['media_id' => $b]]])
            ->assertOk()->assertJsonPath('data.variants.0.image_media_id', null)->assertJsonCount(1, 'data.images');
    }

    public function test_patch_replaces_variants_keeps_ids_and_guards_stock(): void
    {
        Queue::fake();
        [, , $store, $h] = $this->shop();
        $product = $this->createProduct($h, $store, $this->variableProduct(sizes: ['M', 'L', 'XL']));
        $url = "/api/v1/stores/{$store->id}/products/{$product['id']}";
        [$m, $l, $xl] = $product['variants'];

        // Stale revision → 409.
        $this->api($h, 'PATCH', $url, ['revision' => 99, 'name' => 'X'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        // initial_on_hand on an existing variant → 422.
        $this->api($h, 'PATCH', $url, ['revision' => 1, 'variants' => [
            ['id' => $m['id'], 'option_values' => ['M', 'Red'], 'price_amount' => 1, 'initial_on_hand' => 5],
        ]])->assertStatus(422)->assertJsonPath('error.details', ['variants.0.initial_on_hand' => ['Change stock from Inventory.']]);

        $data = $this->api($h, 'PATCH', $url, ['revision' => 1, 'variants' => [
            ['id' => $l['id'], 'option_values' => ['L', 'Red'], 'sku' => $m['sku'], 'price_amount' => 200000, 'on_hand' => 999],
            ['id' => $m['id'], 'option_values' => ['M', 'Red'], 'sku' => $l['sku'], 'price_amount' => 100000, 'is_enabled' => false],
            ['option_values' => ['XL', 'Red'], 'sku' => 'NEW-XL', 'price_amount' => 300000, 'initial_on_hand' => 3],
        ]])->assertOk()->json('data');
        $this->assertSame(2, $data['revision']);
        $this->assertSame($l['id'], $data['variants'][0]['id']);
        $this->assertSame($m['sku'], $data['variants'][0]['sku']);
        $this->assertSame(10, $data['variants'][0]['inventory']['on_hand']); // on_hand ignored
        $this->assertSame(200000, $data['price_min_amount']); // M disabled
        $this->assertSame(300000, $data['price_max_amount']);
        $this->assertNotSame($xl['id'], $data['variants'][2]['id']);
        $this->assertTrue(ProductVariant::withoutTenancy()->withTrashed()->find($xl['id'])->trashed());
        // Old XL SKU is free now.
        $this->createProduct($h, $store, $this->simpleProduct('Free sku', variant: ['sku' => $xl['sku']]));
        // Unknown variant id.
        $this->api($h, 'PATCH', $url, ['revision' => 2, 'variants' => [['id' => $xl['id'], 'option_values' => ['XL', 'Red'], 'price_amount' => 1]]])
            ->assertStatus(422)->assertJsonPath('error.details', ['variants.0.id' => ['Unknown variant.']]);
        Queue::assertPushed(RevalidateStorefront::class);
    }

    public function test_published_at_set_once_and_status_audit(): void
    {
        [, , $store, $h] = $this->shop();
        $product = $this->createProduct($h, $store, $this->simpleProduct());
        $url = "/api/v1/stores/{$store->id}/products/{$product['id']}";
        $first = $this->api($h, 'PATCH', $url, ['revision' => 1, 'status' => 'active'])->assertOk()->json('data.published_at');
        $this->assertNotNull($first);
        $this->api($h, 'PATCH', $url, ['revision' => 2, 'status' => 'draft'])->assertOk();
        $this->travel(5)->minutes();
        $this->api($h, 'PATCH', $url, ['revision' => 3, 'status' => 'active'])->assertOk()->assertJsonPath('data.published_at', $first);
        $this->assertSame(3, AuditLog::query()->where('action', 'product.status_changed')->count());
    }

    public function test_revalidation_only_when_active_or_was_active(): void
    {
        [, , $store, $h] = $this->shop();
        Queue::fake();
        $draft = $this->createProduct($h, $store, $this->simpleProduct());
        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$draft['id']}", ['revision' => 1, 'name' => 'Still draft'])->assertOk();
        Queue::assertNotPushed(RevalidateStorefront::class);

        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$draft['id']}", ['revision' => 2, 'status' => 'active'])->assertOk();
        Queue::assertPushed(RevalidateStorefront::class);
    }

    public function test_duplicate_list_filters_and_bulk(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $cat = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Sarees'])->json('data.id');
        $a = $this->createProduct($h, $store, $this->variableProduct('Alpha') + ['category_ids' => [$cat], 'tags' => ['Eid', 'eid ', 'Sale']]);
        $this->assertSame(['eid', 'sale'], $a['tags']);
        $b = $this->createProduct($h, $store, $this->simpleProduct('Bravo', 5000, variant: ['sku' => 'BR-1', 'barcode' => '123', 'initial_on_hand' => 2]));

        $copy = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products/{$a['id']}/duplicate")->assertCreated()->json('data');
        $this->assertSame('Copy of Alpha', $copy['name']);
        $this->assertSame('alpha-copy', $copy['slug']);
        $this->assertSame('draft', $copy['status']);
        $this->assertSame([null, null], array_column($copy['variants'], 'sku'));
        $this->assertSame([0, 0], array_column(array_column($copy['variants'], 'inventory'), 'on_hand'));
        $this->assertSame([$cat], array_column($copy['categories'], 'id'));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products/{$a['id']}/duplicate")->assertCreated()->assertJsonPath('data.slug', 'alpha-copy-2');

        $list = "/api/v1/stores/{$store->id}/products";
        $this->api($h, 'GET', "{$list}?filter[status]=active")->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('meta.counts', ['all' => 4, 'draft' => 3, 'active' => 1, 'archived' => 0])
            ->assertJsonPath('meta.plan.used', 4)->assertJsonPath('meta.summary.active_variants', 2);
        $this->api($h, 'GET', "{$list}?q=br-")->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.first_sku', 'BR-1');
        $this->api($h, 'GET', "{$list}?q=123")->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', "{$list}?filter[stock]=low")->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.name', 'Bravo');
        $this->api($h, 'GET', "{$list}?filter[category_id]={$cat}&sort=name")->assertOk()->assertJsonCount(3, 'data');
        $this->api($h, 'GET', "{$list}?sort=price")->assertOk()->assertJsonPath('data.0.name', 'Bravo');
        $this->api($h, 'GET', "{$list}?sort=sold")->assertStatus(422);
        $this->api($h, 'GET', "{$list}?filter[vendor]=x")->assertStatus(422);

        // Bulk: foreign/unknown id → 422 and nothing applied; staff can't delete.
        $bulk = "/api/v1/stores/{$store->id}/products/bulk";
        $this->api($h, 'POST', $bulk, ['action' => 'archive', 'ids' => [$a['id'], '01jzzzzzzzzzzzzzzzzzzzzzzz']])
            ->assertStatus(422)->assertJsonPath('error.details', ['ids.1' => ['Unknown product.']]);
        $this->assertSame('active', Product::withoutTenancy()->find($a['id'])->status);
        $this->api($staffH, 'POST', $bulk, ['action' => 'delete', 'ids' => [$b['id']]])->assertForbidden();
        $this->api($staffH, 'POST', $bulk, ['action' => 'activate', 'ids' => [$b['id'], $copy['id']]])
            ->assertOk()->assertJsonPath('data', ['action' => 'activate', 'updated' => 2]);
        $this->api($h, 'POST', $bulk, ['action' => 'set_categories', 'ids' => [$b['id']], 'category_ids' => [$cat]])->assertOk();
        $this->api($h, 'GET', "{$list}/{$b['id']}")->assertJsonPath('data.categories.0.id', $cat)->assertJsonPath('data.revision', 3);
        $this->api($h, 'POST', $bulk, ['action' => 'delete', 'ids' => [$b['id']]])->assertOk();
        $this->api($h, 'GET', "{$list}/{$b['id']}")->assertNotFound();
        $this->assertSame(['action' => 'delete', 'count' => 1], AuditLog::query()->where('action', 'product.bulk_updated')->latest('id')->first()->meta);
    }

    public function test_plan_limit_402_on_free(): void
    {
        $this->seed(PlanSeeder::class);
        [, $tenant, $store, $h] = $this->shop();
        $this->downgradeToFree($tenant);
        $this->tenancy()->run($tenant, function () use ($store) {
            for ($i = 0; $i < 100; $i++) {
                $p = new Product(['name' => "P{$i}", 'slug' => "p-{$i}", 'type' => 'simple', 'currency' => 'BDT']);
                $p->store_id = $store->id;
                $p->save();
            }
        });
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products", $this->simpleProduct())
            ->assertStatus(402)->assertJsonPath('error.code', 'plan_limit_reached')
            ->assertJsonPath('error.message', 'Your plan allows 100 products.')
            ->assertJsonPath('error.details.products.0', 'Your plan allows 100 products.');
        $id = Product::withoutTenancy()->where('store_id', $store->id)->value('id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products/{$id}/duplicate")->assertStatus(402);
        $this->api($h, 'GET', '/api/v1/features')->assertJsonPath('data.limits.products.used', 100);
    }

    protected function downgradeToFree(Tenant $tenant): void
    {
        $this->tenancy()->run($tenant, function () {
            Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]);
        });
        FeatureGate::forget($tenant->id);
    }
}
