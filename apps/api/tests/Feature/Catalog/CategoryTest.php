<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\ProductCategory;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

class CategoryTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public function test_crud_tree_order_and_depth_rule(): void
    {
        [, , $store, $h] = $this->shop(TenantUser::ROLE_STAFF);
        $url = "/api/v1/stores/{$store->id}/categories";

        $women = $this->api($h, 'POST', $url, ['name' => 'Women', 'description' => "Line one\nLine two"])->assertCreated()
            ->assertJsonPath('data.slug', 'women')->assertJsonPath('data.depth', 1)->assertJsonPath('data.url_path', '/c/women')
            ->assertJsonPath('data.position', 0)->assertJsonPath('data.is_visible', true)->json('data');
        $men = $this->api($h, 'POST', $url, ['name' => 'Men'])->assertCreated()->assertJsonPath('data.position', 1)->json('data');
        $sarees = $this->api($h, 'POST', $url, ['name' => 'Sarees', 'parent_id' => $women['id']])->assertCreated()->assertJsonPath('data.depth', 2)->json('data');
        $silk = $this->api($h, 'POST', $url, ['name' => 'Silk', 'parent_id' => $sarees['id']])->assertCreated()->assertJsonPath('data.depth', 3)->json('data');

        $this->api($h, 'POST', $url, ['name' => 'Too deep', 'parent_id' => $silk['id']])
            ->assertStatus(422)->assertJsonPath('error.details.parent_id.0', 'Categories can only be three levels deep.');
        $this->api($h, 'POST', $url, ['name' => 'X', 'slug' => 'women'])
            ->assertStatus(422)->assertJsonPath('error.details.slug.0', 'This link is already used by another category.');
        $this->api($h, 'POST', $url, ['name' => 'Women'])->assertCreated()->assertJsonPath('data.slug', 'women-2');
        $bangla = $this->api($h, 'POST', $url, ['name' => 'শাড়ি'])->assertCreated()->json('data.slug');
        $this->assertMatchesRegularExpression('/^c-[a-z0-9]{6}$/', $bangla);

        $list = $this->api($h, 'GET', $url)->assertOk()->assertJsonPath('meta.limit', 500)->json('data');
        $this->assertSame(['Women', 'Sarees', 'Silk', 'Men', 'Women', 'শাড়ি'], array_column($list, 'name'));
        $this->assertSame(1, $list[0]['children_count']);
        $this->api($h, 'GET', "{$url}?q=sil")->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('meta.count', 1);

        // Move under own descendant → 422; moving Sarees (height 2) under Men → depth recomputed.
        $this->api($h, 'PATCH', "{$url}/{$women['id']}", ['parent_id' => $silk['id']])
            ->assertStatus(422)->assertJsonPath('error.details.parent_id.0', "A category can't be moved inside itself.");
        $this->api($h, 'PATCH', "{$url}/{$sarees['id']}", ['parent_id' => $men['id'], 'name' => 'Saree'])
            ->assertOk()->assertJsonPath('data.depth', 2)->assertJsonPath('data.parent_id', $men['id']);
        $this->api($h, 'GET', "{$url}/{$silk['id']}")->assertOk()->assertJsonPath('data.depth', 3);
        // Moving a 2-high subtree under a depth-2 node would make depth 4.
        $this->api($h, 'PATCH', "{$url}/{$men['id']}", ['parent_id' => $women['id']])
            ->assertStatus(422)->assertJsonPath('error.details.parent_id.0', 'Categories can only be three levels deep.');
    }

    public function test_reorder_full_list_and_rejects_bad_sets(): void
    {
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/categories";
        $a = $this->api($h, 'POST', $url, ['name' => 'A'])->json('data.id');
        $b = $this->api($h, 'POST', $url, ['name' => 'B'])->json('data.id');
        $c = $this->api($h, 'POST', $url, ['name' => 'C'])->json('data.id');

        $data = $this->api($h, 'PUT', "{$url}/order", ['items' => [
            ['id' => $c, 'parent_id' => null], ['id' => $a, 'parent_id' => $c], ['id' => $b, 'parent_id' => $a],
        ]])->assertOk()->json('data');
        $this->assertSame(['C', 'A', 'B'], array_column($data, 'name'));
        $this->assertSame([1, 2, 3], array_column($data, 'depth'));

        $this->api($h, 'PUT', "{$url}/order", ['items' => [['id' => $a, 'parent_id' => null]]])
            ->assertStatus(422)->assertJsonPath('error.details.items.0', 'The list is out of date. Reload and try again.');
        $this->api($h, 'PUT', "{$url}/order", ['items' => [
            ['id' => $a, 'parent_id' => $b], ['id' => $b, 'parent_id' => $a], ['id' => $c, 'parent_id' => null],
        ]])->assertStatus(422);
    }

    public function test_delete_rules_and_revalidation(): void
    {
        Queue::fake();
        [$owner, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $url = "/api/v1/stores/{$store->id}/categories";
        $parent = $this->api($h, 'POST', $url, ['name' => 'Parent'])->json('data.id');
        $leaf = $this->api($h, 'POST', $url, ['name' => 'Leaf', 'parent_id' => $parent])->json('data.id');
        Queue::assertPushed(RevalidateStorefront::class);

        $product = $this->createProduct($h, $store, $this->simpleProduct(extra: ['category_ids' => [$leaf]]));
        $this->api($h, 'GET', "{$url}/{$leaf}")->assertJsonPath('data.product_count', 1);

        $this->api($staffH, 'DELETE', "{$url}/{$leaf}")->assertForbidden();
        $this->api($h, 'DELETE', "{$url}/{$parent}")->assertStatus(409)->assertJsonPath('error.code', 'category_has_children');
        $this->api($h, 'DELETE', "{$url}/{$leaf}")->assertNoContent();
        $this->api($h, 'GET', "{$url}/{$leaf}")->assertNotFound();
        $this->assertSame(0, ProductCategory::withoutTenancy()->where('product_id', $product['id'])->count());
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'category.deleted')->exists());
        // The slug is free again.
        $this->api($h, 'POST', $url, ['name' => 'Leaf'])->assertCreated()->assertJsonPath('data.slug', 'leaf');
    }

    public function test_limit_500_and_same_slug_in_another_store(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, , $other, $h2] = $this->shop();
        $this->tenancy()->run($tenant, function () use ($store) {
            for ($i = 0; $i < 500; $i++) {
                $c = new Category(['name' => "C{$i}", 'slug' => "c-{$i}", 'depth' => 1, 'position' => $i]);
                $c->store_id = $store->id;
                $c->save();
            }
        });
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'One more'])
            ->assertStatus(409)->assertJsonPath('error.code', 'category_limit_reached');
        $this->api($h2, 'POST', "/api/v1/stores/{$other->id}/categories", ['name' => 'C0', 'slug' => 'c-0'])->assertCreated();
    }
}
