<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Catalog\Models\ProductVariant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8C P88C-7 / Q220: CSV `stock` writes the default location; an optional `location` column (by name). */
#[Group('locations')]
class ImportLocationTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
        Storage::fake('local');
        config(['storeplix.bulk_per_hour' => 1000]);
    }

    /** @return array<string, mixed> DataImport (validated) */
    private function validated(array $h, $store, string $csv): array
    {
        $import = $this->flushHeaders()->withHeaders($h)->post("/api/v1/stores/{$store->id}/imports", [
            'type' => 'products', 'file' => UploadedFile::fake()->createWithContent('p.csv', $csv),
        ], ['Accept' => 'application/json'])->assertCreated()->json('data');

        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/validate", [
            'column_map' => $import['suggested_map'],
            'options' => ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true],
        ])->assertStatus(202)->json('data');
    }

    public function test_location_column_targets_a_named_location(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        $shop = $this->addLocation($h, $store, 'Dhanmondi shop');

        $csv = "name,sku,price,stock,location\nTee,TEE-1,950,5,\nCap,CAP-1,500,7,dhanmondi SHOP\nBad,BAD-1,100,1,Nowhere\n";
        $import = $this->validated($h, $store, $csv);
        $this->assertSame(1, $import['summary']['errors']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$import['id']}/run")->assertStatus(202);

        $tee = $this->inTenant($tenant, fn () => ProductVariant::query()->where('sku', 'TEE-1')->value('id'));
        $cap = $this->inTenant($tenant, fn () => ProductVariant::query()->where('sku', 'CAP-1')->value('id'));
        $this->assertSame(5, $this->row($tenant, $tee, $main->id)['on_hand']);
        $this->assertSame(7, $this->row($tenant, $cap, $shop['id'])['on_hand']);
        $this->assertNull($this->row($tenant, $cap, $main->id)); // stock went only where the file said

        // Update: set stock at the shop; the main row is untouched; the same file again is unchanged.
        $csv2 = "name,sku,price,stock,location\nTee,TEE-1,950,3,Dhanmondi shop\n";
        $again = $this->validated($h, $store, $csv2);
        $this->assertSame(1, $again['summary']['update']);
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/imports/{$again['id']}/run")->assertStatus(202);
        $this->assertSame(5, $this->row($tenant, $tee, $main->id)['on_hand']);
        $this->assertSame(3, $this->row($tenant, $tee, $shop['id'])['on_hand']);
        $this->assertSame(1, $this->validated($h, $store, $csv2)['summary']['unchanged']);
    }
}
