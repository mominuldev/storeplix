<?php

namespace Tests\Feature\Catalog;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductVariant;
use Database\Seeders\PlanSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

/** §5.4 target: 5 000 product rows (≈ 1 667 products × 3 variants) validate + run in < 120 s (CI Postgres). */
#[Group('perf')]
class ImportPerformanceTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public function test_5000_rows_validate_and_run_under_two_minutes(): void
    {
        Storage::fake('local');
        config(['storeplix.bulk_per_hour' => 1000]);
        $this->seed(PlanSeeder::class);
        [, $tenant, $store, $h] = $this->shop();
        $this->tenancy()->run($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', 'growth')->value('id')]));
        FeatureGate::forget($tenant->id);

        $lines = ['handle,name,description,category,option1_name,option1_value,sku,price,compare_at_price,cost_price,stock'];
        for ($i = 0; count($lines) <= 5000; $i++) {
            foreach (['S', 'M', 'L'] as $size) {
                if (count($lines) > 5000) {
                    break;
                }
                $first = $size === 'S';
                $lines[] = implode(',', [
                    "product-{$i}", $first ? "Product {$i}" : '', $first ? 'Soft cotton' : '', $first ? 'Women > Tops' : '',
                    'Size', $size, "SKU-{$i}-{$size}", '1,250', '1500', '700', (string) ($i % 50),
                ]);
            }
        }
        $csv = implode("\n", $lines)."\n";

        $started = microtime(true);
        $import = $this->flushHeaders()->withHeaders($h)->post("/api/v1/stores/{$store->id}/imports", [
            'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('big.csv', $csv),
        ], ['Accept' => 'application/json'])->assertCreated()->assertJsonPath('data.row_count', 5000)->json('data');
        $validated = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/validate", [
            'column_map' => $import['suggested_map'], 'options' => ImportExportTest::OPTIONS,
        ])->assertStatus(202)->json('data');
        $this->assertSame('validated', $validated['status']);
        $this->assertSame(0, $validated['summary']['errors']);
        $validateSeconds = microtime(true) - $started;

        $done = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")->assertStatus(202)->json('data');
        $total = microtime(true) - $started;
        $this->assertSame('completed', $done['status']);
        $this->assertSame(1667, Product::withoutTenancy()->where('store_id', $store->id)->count());
        $this->assertSame(5000, ProductVariant::withoutTenancy()->where('store_id', $store->id)->count());
        fwrite(STDERR, sprintf("\n[perf] 5000 rows: validate %.1fs, total %.1fs\n", $validateSeconds, $total));
        $this->assertLessThan(120, $total);
    }
}
