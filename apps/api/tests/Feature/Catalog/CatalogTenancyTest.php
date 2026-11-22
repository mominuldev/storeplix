<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductCategory;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Customers\Models\Customer;
use App\Domain\Customers\Models\CustomerNote;
use App\Domain\DataTransfer\Import\ImportFile;
use App\Domain\DataTransfer\Jobs\RunExport;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\DataTransfer\Models\DataImportRow;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\CatalogFixtures;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** Phase 4 tenancy group (§12): isolation of every new model, foreign ids in payloads (422) and routes (404). */
#[Group('tenancy')]
class CatalogTenancyTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase, StorefrontContent;

    /** @return array<string, mixed> */
    private function world(): array
    {
        Storage::fake('public');
        Storage::fake('local');
        $w = [];
        foreach (['a', 'b'] as $k) {
            [$user, $tenant, $store, $h] = $this->shop();
            $cat = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/categories", ['name' => 'Sarees'])->json('data.id');
            $media = $this->productImage($h);
            $product = $this->createProduct($h, $store, $this->variableProduct() + ['category_ids' => [$cat], 'images' => [['media_id' => $media]]]);
            $customer = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'C', 'phone' => '01711111111'])->json('data.id');
            $note = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer}/notes", ['body' => 'n'])->json('data.id');
            $import = $this->flushHeaders()->withHeaders($h)->post("/api/v1/stores/{$store->id}/imports", [
                'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('f.csv', "name,price\nA,1\n"),
            ], ['Accept' => 'application/json'])->json('data.id');
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import}/validate", ['column_map' => ['name' => 'name', 'price' => 'price'], 'options' => ImportExportTest::OPTIONS]);
            $export = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'customers'])->json('data.id');
            $w[$k] = compact('user', 'tenant', 'store', 'h', 'cat', 'media', 'product', 'customer', 'note', 'import', 'export');
        }

        return $w;
    }

    public function test_every_model_is_tenant_and_store_isolated(): void
    {
        $w = $this->world();
        $models = [Category::class, Product::class, ProductVariant::class, ProductImage::class, ProductCategory::class, Inventory::class,
            InventoryMovement::class, Customer::class, CustomerNote::class, DataImport::class, DataImportRow::class, DataExport::class];
        foreach ($models as $model) {
            $this->assertStoreIsolation($model, $w['a']['tenant'], $w['a']['store'], $w['b']['store']);
            $this->tenancy()->run($w['a']['tenant'], fn () => $this->assertGreaterThan(0, $model::query()->count(), $model));
        }
        // Without a tenant context, tenant-owned queries throw instead of reading every tenant.
        $this->expectException(MissingTenantContextException::class);
        Product::query()->count();
    }

    public function test_foreign_ids_in_routes_are_404(): void
    {
        $w = $this->world();
        $a = $w['a'];
        $b = $w['b'];
        $variantB = $b['product']['variants'][0]['id'];
        foreach ([$b['store']->id, $a['store']->id] as $storeId) {
            $base = "/api/v1/stores/{$storeId}";
            $this->assertTenantIsolation($a['h'], [
                ['GET', "{$base}/categories/{$b['cat']}"],
                ['PATCH', "{$base}/categories/{$b['cat']}", ['name' => 'Pwned']],
                ['DELETE', "{$base}/categories/{$b['cat']}"],
                ['GET', "{$base}/products/{$b['product']['id']}"],
                ['PATCH', "{$base}/products/{$b['product']['id']}", ['revision' => 1, 'name' => 'Pwned']],
                ['DELETE', "{$base}/products/{$b['product']['id']}"],
                ['POST', "{$base}/products/{$b['product']['id']}/duplicate"],
                ['PATCH', "{$base}/inventory/{$variantB}", ['low_stock_threshold' => 1]],
                ['GET', "{$base}/customers/{$b['customer']}"],
                ['PATCH', "{$base}/customers/{$b['customer']}", ['revision' => 1, 'name' => 'Pwned']],
                ['DELETE', "{$base}/customers/{$b['customer']}"],
                ['POST', "{$base}/customers/{$b['customer']}/notes", ['body' => 'x']],
                ['DELETE', "{$base}/customers/{$b['customer']}/notes/{$b['note']}"],
                ['GET', "{$base}/imports/{$b['import']}"],
                ['GET', "{$base}/imports/{$b['import']}/rows"],
                ['GET', "{$base}/imports/{$b['import']}/error-report"],
                ['POST', "{$base}/imports/{$b['import']}/run"],
                ['DELETE', "{$base}/imports/{$b['import']}"],
                ['GET', "{$base}/exports/{$b['export']}"],
            ]);
        }
        // Lists of store B through A's headers → 404 (store not in tenant).
        foreach (['categories', 'products', 'inventory', 'inventory/movements', 'customers', 'dashboard'] as $list) {
            $this->api($a['h'], 'GET', "/api/v1/stores/{$b['store']->id}/{$list}")->assertNotFound();
        }
        // A's note under A's customer path but B's note id → 404; A's customer with B's note.
        $this->api($a['h'], 'DELETE', "/api/v1/stores/{$a['store']->id}/customers/{$a['customer']}/notes/{$b['note']}")->assertNotFound();
        $this->assertSame('Jamdani Three-Piece', Product::withoutTenancy()->find($b['product']['id'])->name);
    }

    public function test_foreign_ids_in_payloads_are_422(): void
    {
        $w = $this->world();
        $a = $w['a'];
        $b = $w['b'];
        $base = "/api/v1/stores/{$a['store']->id}";
        $variantB = $b['product']['variants'][0]['id'];

        $this->api($a['h'], 'POST', "{$base}/categories", ['name' => 'X', 'parent_id' => $b['cat']])
            ->assertStatus(422)->assertJsonPath('error.details.parent_id.0', 'Unknown category.');
        $this->api($a['h'], 'POST', "{$base}/categories", ['name' => 'X', 'image_media_id' => $b['media']])
            ->assertStatus(422)->assertJsonPath('error.details.image_media_id.0', 'Unknown image.');
        $this->api($a['h'], 'POST', "{$base}/products", $this->simpleProduct(extra: ['category_ids' => [$b['cat']]]))
            ->assertStatus(422)->assertJsonPath('error.details', ['category_ids.0' => ['Unknown category.']]);
        $this->api($a['h'], 'POST', "{$base}/products", $this->simpleProduct(extra: ['images' => [['media_id' => $b['media']]]]))
            ->assertStatus(422)->assertJsonPath('error.details', ['images.0.media_id' => ['Unknown image.']]);
        $payload = $this->variableProduct();
        $payload['variants'][0]['id'] = $variantB;
        $this->api($a['h'], 'PATCH', "{$base}/products/{$a['product']['id']}", ['revision' => 1, 'options' => $payload['options'], 'variants' => $payload['variants']])
            ->assertStatus(422)->assertJsonPath('error.details', ['variants.0.id' => ['Unknown variant.']]);
        $this->api($a['h'], 'POST', "{$base}/inventory/adjustments", ['reason' => 'received', 'items' => [['variant_id' => $variantB, 'mode' => 'delta', 'quantity' => 1]]])
            ->assertStatus(422)->assertJsonPath('error.details', ['items.0.variant_id' => ['Unknown variant.']]);
        $this->api($a['h'], 'POST', "{$base}/products/bulk", ['action' => 'archive', 'ids' => [$b['product']['id']]])
            ->assertStatus(422)->assertJsonPath('error.details', ['ids.0' => ['Unknown product.']]);
        $this->api($a['h'], 'POST', "{$base}/products/bulk", ['action' => 'set_categories', 'ids' => [$a['product']['id']], 'category_ids' => [$b['cat']]])
            ->assertStatus(422);
        $this->assertSame('active', Product::withoutTenancy()->find($b['product']['id'])->status);
        $this->assertSame(10, Inventory::withoutTenancy()->where('variant_id', $variantB)->value('on_hand'));
    }

    public function test_same_sku_and_slug_in_another_tenant_is_allowed(): void
    {
        $w = $this->world();
        // Both worlds created "JT-Red-M" / "jamdani-three-piece" independently.
        $this->assertSame($w['a']['product']['slug'], $w['b']['product']['slug']);
        $this->assertSame($w['a']['product']['variants'][0]['sku'], $w['b']['product']['variants'][0]['sku']);
        // A's import does not match B's SKU (would be "update" if it leaked): it creates.
        $this->assertSame(1, DataImport::withoutTenancy()->find($w['a']['import'])->summary['create']);
    }

    public function test_jobs_restore_tenant_and_never_read_another_tenants_file(): void
    {
        $w = $this->world();
        $importB = DataImport::withoutTenancy()->find($w['b']['import']);
        // Under A's context, B's import is invisible and B's file path is refused.
        $this->tenancy()->run($w['a']['tenant'], function () use ($importB) {
            $this->assertNull(DataImport::query()->find($importB->id));
            $this->expectException(RuntimeException::class);
            ImportFile::withLocalPath($importB, fn () => null);
        });
    }

    public function test_export_job_for_tenant_b_id_does_nothing_under_a(): void
    {
        $w = $this->world();
        $exportB = DataExport::withoutTenancy()->find($w['b']['export']);
        $before = $exportB->updated_at;
        $this->tenancy()->run($w['a']['tenant'], fn () => app()->call([new RunExport($exportB->id), 'handle']));
        $this->assertEquals($before, DataExport::withoutTenancy()->find($exportB->id)->updated_at);
        // The export download URL is bound to its own tenant.
        $url = $this->api($w['b']['h'], 'GET', "/api/v1/stores/{$w['b']['store']->id}/exports/{$exportB->id}")->json('data.download_url');
        $tampered = str_replace($w['b']['tenant']->id, $w['a']['tenant']->id, $url);
        $this->get($tampered)->assertForbidden();
        $this->get($url)->assertOk();
    }
}
