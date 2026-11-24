<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8C §5.1, §5.4: per-location stock rows (P88C-3), adjust / threshold / inventory list / movements with a
 * location, "All locations" totals (S180, P88C-7).
 */
#[Group('locations')]
class PerLocationStockTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_adjust_at_a_location_creates_the_row_lazily_and_ledgers_the_location(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [, $variant] = $this->stocked($h, $store, stock: 10);
        $this->api($h, 'PATCH', $this->lUrl($store, "/inventory/{$variant}"), ['low_stock_threshold' => 3])->assertOk();
        $shop = $this->addLocation($h, $store);
        $this->assertNull($this->row($tenant, $variant, $shop['id']));

        // A negative delta / zero set at a location without a row creates nothing.
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => -1, 'location_id' => $shop['id']]], 'lost')
            ->assertUnprocessable()->assertJsonPath('error.code', 'insufficient_stock');
        $this->assertNull($this->row($tenant, $variant, $shop['id']));

        $res = $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 4, 'location_id' => $shop['id'], 'expected_on_hand' => 0]])->assertOk();
        $res->assertJsonPath('data.items.0.location_id', $shop['id'])
            ->assertJsonPath('data.items.0.on_hand', 4)
            ->assertJsonPath('data.items.0.low_stock_threshold', 3) // copied from the default row
            ->assertJsonPath('data.movements.0.location', ['id' => $shop['id'], 'name' => 'Dhanmondi shop'])
            ->assertJsonPath('data.movements.0.delta', 4);
        $this->assertSame(['on_hand' => 4, 'committed' => 0], $this->row($tenant, $variant, $shop['id']));
        $this->assertSame(['on_hand' => 10, 'committed' => 0], $this->row($tenant, $variant, $main->id));

        // Without a location: the default row (P88C-7). `set` and expected_on_hand apply to the named row.
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 8, 'expected_on_hand' => 10]], 'correction')->assertOk()
            ->assertJsonPath('data.items.0.location_id', null)->assertJsonPath('data.items.0.on_hand', 12); // All locations: 8 + 4
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 1, 'expected_on_hand' => 9, 'location_id' => $shop['id']]], 'correction')
            ->assertStatus(409)->assertJsonPath('error.code', 'stock_changed');
        $this->assertSame(8, $this->row($tenant, $variant, $main->id)['on_hand']);

        // Same variant at two locations in one call is fine; the same row twice is not.
        $this->adjustAt($h, $store, [
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1],
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $shop['id']],
        ])->assertOk()->assertJsonCount(2, 'data.movements');
        $this->adjustAt($h, $store, [
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1],
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $main->id],
        ])->assertUnprocessable()->assertJsonValidationErrors(['items.1.variant_id'], 'error.details');

        $this->inTenant($tenant, function () use ($shop) {
            $this->assertSame(0, InventoryMovement::query()->whereNull('location_id')->count());
            $this->assertSame(2, InventoryMovement::query()->where('location_id', $shop['id'])->count());
        });

        // Staff has inventory.adjust: a location adjust works (S180).
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->adjustAt($staff, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => -1, 'location_id' => $shop['id']]], 'damaged')->assertOk();
    }

    public function test_inventory_list_all_locations_vs_one_location_and_movement_filter(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [, $a] = $this->stocked($h, $store, stock: 6, variant: ['cost_amount' => 1000]);
        [, $b] = $this->stocked($h, $store, stock: 0);
        $shop = $this->addLocation($h, $store);
        $this->adjustAt($h, $store, [['variant_id' => $a, 'mode' => 'delta', 'quantity' => 2, 'location_id' => $shop['id']]])->assertOk();

        $all = $this->api($h, 'GET', $this->lUrl($store, '/inventory?sort=-available'))->assertOk();
        $all->assertJsonPath('data.0.variant_id', $a)
            ->assertJsonPath('data.0.location_id', null)
            ->assertJsonPath('data.0.on_hand', 8)
            ->assertJsonPath('data.0.locations', [
                ['id' => $main->id, 'name' => 'Main warehouse', 'on_hand' => 6, 'committed' => 0, 'available' => 6],
                ['id' => $shop['id'], 'name' => 'Dhanmondi shop', 'on_hand' => 2, 'committed' => 0, 'available' => 2],
            ])
            ->assertJsonPath('data.1.locations.1.on_hand', 0) // missing row = 0
            ->assertJsonPath('meta.summary.units_on_hand', 8)
            ->assertJsonPath('meta.summary.stock_value_cost_amount', 8000);

        $one = $this->api($h, 'GET', $this->lUrl($store, '/inventory?sort=-available&filter[location_id]='.$shop['id']))->assertOk();
        $one->assertJsonPath('data.0.location_id', $shop['id'])->assertJsonPath('data.0.on_hand', 2)
            ->assertJsonPath('data.0.status', 'low_stock')
            ->assertJsonPath('data.1.on_hand', 0)->assertJsonPath('data.1.status', 'out_of_stock')
            ->assertJsonCount(2, 'data.0.locations')
            ->assertJsonPath('meta.summary.units_on_hand', 2);
        // Stock filters work on the location's numbers: `out` at the shop includes the variant without a row there.
        $this->api($h, 'GET', $this->lUrl($store, '/inventory?filter[stock]=out&filter[location_id]='.$shop['id']))->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.variant_id', $b);
        $this->api($h, 'GET', $this->lUrl($store, '/inventory?filter[stock]=out'))->assertOk()->assertJsonCount(1, 'data');

        $moves = $this->api($h, 'GET', $this->lUrl($store, '/inventory/movements?filter[location_id]='.$shop['id']))->assertOk();
        $moves->assertJsonCount(1, 'data')->assertJsonPath('data.0.location.id', $shop['id']);
        $this->api($h, 'GET', $this->lUrl($store, '/inventory/movements'))->assertOk()->assertJsonPath('data.1.location', ['id' => $main->id, 'name' => 'Main warehouse']);
        $this->api($h, 'GET', $this->lUrl($store, '/inventory/movements?filter[reason]=transfer_out,count'))->assertOk()->assertJsonCount(0, 'data');
    }

    public function test_threshold_is_per_location_row(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [, $variant] = $this->stocked($h, $store, stock: 4);
        $shop = $this->addLocation($h, $store);

        // No row at the shop yet: a threshold-only row (on_hand 0), no ledger.
        $this->api($h, 'PATCH', $this->lUrl($store, "/inventory/{$variant}"), ['low_stock_threshold' => 1, 'location_id' => $shop['id']])->assertOk()
            ->assertJsonPath('data.location_id', $shop['id'])->assertJsonPath('data.low_stock_threshold', 1);
        $this->api($h, 'PATCH', $this->lUrl($store, "/inventory/{$variant}"), ['low_stock_threshold' => 9])->assertOk()
            ->assertJsonPath('data.location_id', null)->assertJsonPath('data.low_stock_threshold', 9);
        $this->inTenant($tenant, function () use ($variant, $main, $shop) {
            $this->assertSame(9, Inventory::query()->where('variant_id', $variant)->where('location_id', $main->id)->value('low_stock_threshold'));
            $this->assertSame(1, Inventory::query()->where('variant_id', $variant)->where('location_id', $shop['id'])->value('low_stock_threshold'));
            $this->assertSame(1, InventoryMovement::query()->where('variant_id', $variant)->count());
        });
        $this->api($h, 'GET', $this->lUrl($store, '/inventory?filter[location_id]='.$shop['id']))->assertOk()->assertJsonPath('data.0.status', 'out_of_stock');
    }

    public function test_product_editor_block_reports_online_row_and_other_locations(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [$product, $variant] = $this->stocked($h, $store, stock: 5);
        $product['variants'][0]['inventory']['location_id'] === $main->id || $this->fail('location_id is the online location');
        $this->assertSame(5, $product['variants'][0]['inventory']['total_on_hand']);
        $this->assertSame(0, $product['variants'][0]['inventory']['other_locations_on_hand']);

        $shop = $this->addLocation($h, $store);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 3, 'location_id' => $shop['id']]])->assertOk();
        $this->api($h, 'GET', $this->lUrl($store, "/products/{$product['id']}"))->assertOk()
            ->assertJsonPath('data.variants.0.inventory.on_hand', 5)
            ->assertJsonPath('data.variants.0.inventory.location_id', $main->id)
            ->assertJsonPath('data.variants.0.inventory.total_on_hand', 8)
            ->assertJsonPath('data.variants.0.inventory.other_locations_on_hand', 3)
            ->assertJsonPath('data.stock.on_hand', 8);

        // The editor's stock field (an adjust without location) still writes the default location.
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 2]], 'correction')->assertOk();
        $this->assertSame(2, $this->row($tenant, $variant, $main->id)['on_hand']);
        $this->assertSame(3, $this->row($tenant, $variant, $shop['id'])['on_hand']);
    }
}
