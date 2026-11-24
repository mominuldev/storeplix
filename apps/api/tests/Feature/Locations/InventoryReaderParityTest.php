<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8C S185 (P88C-6, §5.3): with stock at two locations every TOTAL reader equals Σ over the locations and every
 * ONLINE reader equals the online row; and no code joins `inventories` 1:1 outside InventorySql (static check).
 */
#[Group('locations')]
#[Group('security')]
class InventoryReaderParityTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    /** Files allowed to join `inventories` into a variant query (each join there is classified). */
    private const JOIN_ALLOW_LIST = ['app/Domain/Inventory/InventorySql.php'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_no_one_to_one_inventory_join_outside_the_allow_list(): void
    {
        $offenders = [];
        foreach (File::allFiles(app_path()) as $file) {
            $relative = 'app/'.str_replace('\\', '/', $file->getRelativePathname());
            if (in_array($relative, self::JOIN_ALLOW_LIST, true)) {
                continue;
            }
            if (preg_match('/(join|leftJoin|rightJoin|joinSub|crossJoin)\(\s*[\'"]inventories[\'" ]/i', $file->getContents()) === 1) {
                $offenders[] = $relative;
            }
        }
        $this->assertSame([], $offenders, 'Join inventories only through App\Domain\Inventory\InventorySql (online / totals / location).');
    }

    public function test_total_and_online_readers_with_two_locations(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [$product, $variant] = $this->stocked($h, $store, price: 10000, stock: 6, variant: ['cost_amount' => 4000]);
        $shop = $this->addLocation($h, $store);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 4, 'location_id' => $shop['id']]])->assertOk();
        $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated(); // 1 committed at main
        $base = "/api/v1/stores/{$store->id}";

        // ---- TOTAL readers: Σ over locations (on hand 10, committed 1, available 9) ----
        $dash = $this->api($h, 'GET', "{$base}/dashboard")->assertOk();
        $dash->assertJsonPath('data.inventory.units_on_hand', 10)
            ->assertJsonPath('data.inventory.stock_value_cost_amount', 40000)
            ->assertJsonPath('data.inventory.low_stock_variants', 1) // the shop row (4 ≤ 5) is low
            ->assertJsonPath('data.inventory.out_of_stock_variants', 0);

        $inv = $this->api($h, 'GET', "{$base}/inventory")->assertOk();
        $inv->assertJsonPath('data.0.on_hand', 10)->assertJsonPath('data.0.committed', 1)->assertJsonPath('data.0.available', 9)
            ->assertJsonPath('data.0.status', 'in_stock')
            ->assertJsonPath('meta.summary.units_on_hand', 10)->assertJsonPath('meta.summary.committed_units', 1)
            ->assertJsonPath('meta.summary.stock_value_cost_amount', 40000)->assertJsonPath('meta.summary.stock_value_price_amount', 100000);

        $list = $this->api($h, 'GET', "{$base}/products")->assertOk();
        $list->assertJsonPath('data.0.stock.on_hand', 10)->assertJsonPath('data.0.stock.available', 9)
            ->assertJsonPath('meta.summary.low_stock_variants', 0);
        $this->assertCount(1, $this->api($h, 'GET', "{$base}/products?filter[stock]=in")->json('data'));
        $this->assertCount(0, $this->api($h, 'GET', "{$base}/products?filter[stock]=out")->json('data'));

        $export = $this->api($h, 'POST', "{$base}/exports", ['type' => 'products'])->assertStatus(202)->json('data');
        $csv = $this->get($export['download_url'])->assertOk()->streamedContent();
        $rows = array_map('str_getcsv', array_values(array_filter(explode("\n", $csv))));
        $stockColumn = array_search('stock', $rows[0], true);
        $this->assertSame('10', $rows[1][$stockColumn]);

        // ---- ONLINE readers: the main row (on hand 6, committed 1, available 5) ----
        $this->api($h, 'GET', "{$base}/products/{$product['id']}")->assertOk()
            ->assertJsonPath('data.variants.0.inventory.on_hand', 6)->assertJsonPath('data.variants.0.inventory.available', 5)
            ->assertJsonPath('data.variants.0.inventory.location_id', $main->id)
            ->assertJsonPath('data.variants.0.inventory.total_on_hand', 10);
        $this->sf($store, 'GET', "/products/{$product['slug']}/availability")->assertOk()->assertJsonPath('data.variants.0.low_stock', 5);
        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 6])->assertUnprocessable()->assertJsonPath('error.code', 'out_of_stock');
        $this->cartWith($store, $variant, 5);
        $order = $this->api($h, 'GET', "{$base}/orders")->assertOk()->json('data.0.id');
        $this->api($h, 'GET', "{$base}/orders/{$order}")->assertOk()->assertJsonPath('data.items.0.current_stock', ['available' => 5, 'tracked' => true]);

        // ---- LOCATION readers ----
        $this->api($h, 'GET', "{$base}/inventory?filter[location_id]={$shop['id']}")->assertOk()->assertJsonPath('data.0.on_hand', 4)->assertJsonPath('data.0.status', 'low_stock');
        $this->api($h, 'GET', "{$base}/inventory?filter[location_id]={$main->id}")->assertOk()->assertJsonPath('data.0.available', 5);
    }

    /** Reorder suggestions use Σ available over locations (§5.3). */
    public function test_reorder_suggestions_use_total_available(): void
    {
        [, , $store, $h] = $this->growthShop();
        [, $variant] = $this->stocked($h, $store, stock: 30);
        $shop = $this->addLocation($h, $store);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 5, 'location_id' => $shop['id']]])->assertOk();
        $order = $this->manual($h, $store, $this->manualBody($variant, 30))->assertCreated()->json('data');
        foreach (['confirm', 'ship'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}")->assertOk();
        }

        $groups = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/purchasing/reorder-suggestions")->assertOk()->json('data');
        $this->assertSame(5, $groups[0]['items'][0]['available']); // main 0 + shop 5 (online alone would say 0)
    }
}
