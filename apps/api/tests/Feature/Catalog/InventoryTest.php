<?php

namespace Tests\Feature\Catalog;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use LogicException;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

class InventoryTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public function test_delta_set_ledger_and_atomic_failures(): void
    {
        [$user, , $store, $h] = $this->shop(TenantUser::ROLE_STAFF);
        $p = $this->createProduct($h, $store, $this->variableProduct(sizes: ['M', 'L']));
        [$m, $l] = array_column($p['variants'], 'id');
        $url = "/api/v1/stores/{$store->id}/inventory/adjustments";

        $res = $this->api($h, 'POST', $url, ['reason' => 'received', 'note' => 'Supplier', 'items' => [
            ['variant_id' => $m, 'mode' => 'delta', 'quantity' => 5],
            ['variant_id' => $l, 'mode' => 'set', 'quantity' => 10, 'expected_on_hand' => 10], // zero delta → no row
        ]])->assertOk()->json('data');
        $this->assertSame([15, 10], array_column($res['items'], 'on_hand'));
        $this->assertCount(1, $res['movements']);
        $this->assertSame(5, $res['movements'][0]['delta']);
        $this->assertSame(15, $res['movements'][0]['on_hand_after']);
        $this->assertSame('received', $res['movements'][0]['reason']);
        $this->assertSame($user->id, $res['movements'][0]['actor']['id']);

        // Negative → 422 insufficient_stock and NOTHING written (also for the valid first item).
        $before = InventoryMovement::withoutTenancy()->count();
        $this->api($h, 'POST', $url, ['reason' => 'damaged', 'items' => [
            ['variant_id' => $l, 'mode' => 'delta', 'quantity' => -1],
            ['variant_id' => $m, 'mode' => 'delta', 'quantity' => -16],
        ]])->assertStatus(422)->assertJsonPath('error.code', 'insufficient_stock')
            ->assertJsonPath('error.details', ['items.1.quantity' => ['Only 15 in stock.']]);
        $this->assertSame($before, InventoryMovement::withoutTenancy()->count());
        $this->assertSame(10, Inventory::withoutTenancy()->where('variant_id', $l)->value('on_hand'));

        // expected_on_hand mismatch → 409 stock_changed.
        $this->api($h, 'POST', $url, ['reason' => 'correction', 'items' => [['variant_id' => $m, 'mode' => 'set', 'quantity' => 3, 'expected_on_hand' => 12]]])
            ->assertStatus(409)->assertJsonPath('error.code', 'stock_changed')
            ->assertJsonPath('error.details', ['items.0.expected_on_hand' => ['Stock changed to 15 since you opened this. Check and try again.']]);

        // Validation: other needs a note, zero delta, unknown variant.
        $this->api($h, 'POST', $url, ['reason' => 'other', 'items' => [['variant_id' => $m, 'mode' => 'delta', 'quantity' => 1]]])
            ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['note']]]);
        $this->api($h, 'POST', $url, ['reason' => 'lost', 'items' => [['variant_id' => $m, 'mode' => 'delta', 'quantity' => 0]]])->assertStatus(422);
        $this->api($h, 'POST', $url, ['reason' => 'initial', 'items' => [['variant_id' => $m, 'mode' => 'delta', 'quantity' => 1]]])->assertStatus(422);
        $this->api($h, 'POST', $url, ['reason' => 'lost', 'items' => [['variant_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'mode' => 'delta', 'quantity' => 1]]])
            ->assertStatus(422)->assertJsonPath('error.details', ['items.0.variant_id' => ['Unknown variant.']]);

        // Movements list + filters, newest first.
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory/movements?filter[variant_id]={$m}")->assertOk()
            ->assertJsonCount(2, 'data')->assertJsonPath('data.0.reason', 'received')->assertJsonPath('data.1.reason', 'initial');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory/movements?filter[reason]=initial&filter[product_id]={$p['id']}")->assertOk()->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory/movements?filter[reason]=bogus")->assertStatus(422);
    }

    public function test_status_thresholds_summary_and_staff_cost(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $p = $this->createProduct($h, $store, [
            'name' => 'Tee', 'status' => 'active',
            'options' => [['name' => 'Size', 'values' => ['S', 'M', 'L', 'XL']]],
            'variants' => [
                ['option_values' => ['S'], 'price_amount' => 1000, 'cost_amount' => 600, 'initial_on_hand' => 0],
                ['option_values' => ['M'], 'price_amount' => 1000, 'cost_amount' => 600, 'initial_on_hand' => 5],
                ['option_values' => ['L'], 'price_amount' => 1000, 'cost_amount' => 600, 'initial_on_hand' => 6, 'low_stock_threshold' => 10],
                ['option_values' => ['XL'], 'price_amount' => 1000, 'initial_on_hand' => 0, 'track_inventory' => false],
            ],
        ]);
        $this->assertSame(['out_of_stock', 'low_stock', 'low_stock', 'untracked'], array_column(array_column($p['variants'], 'inventory'), 'status'));

        $list = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory")->assertOk();
        $list->assertJsonPath('meta.summary.units_on_hand', 11)->assertJsonPath('meta.summary.stock_value_price_amount', 11000)
            ->assertJsonPath('meta.summary.stock_value_cost_amount', 6600)->assertJsonPath('meta.summary.low_stock_variants', 2)
            ->assertJsonPath('meta.summary.out_of_stock_variants', 1)->assertJsonPath('meta.summary.variants_count', 4)
            ->assertJsonPath('meta.summary.committed_units', 0)->assertJsonPath('data.0.cost_amount', 600);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory?filter[stock]=untracked,out")->assertJsonCount(2, 'data');
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory?sort=-available")->assertJsonPath('data.0.on_hand', 6);

        $staff = $this->api($staffH, 'GET', "/api/v1/stores/{$store->id}/inventory")->assertOk()
            ->assertJsonPath('meta.summary.stock_value_cost_amount', null)->json('data');
        $this->assertSame([null, null, null, null], array_column($staff, 'cost_amount'));

        $variant = $p['variants'][1]['id'];
        $this->api($staffH, 'PATCH', "/api/v1/stores/{$store->id}/inventory/{$variant}", ['low_stock_threshold' => 2])
            ->assertOk()->assertJsonPath('data.status', 'in_stock')->assertJsonPath('data.effective_threshold', 2);
    }

    public function test_ledger_rows_are_append_only(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->createProduct($h, $store, $this->simpleProduct(variant: ['initial_on_hand' => 3]));
        $this->tenancy()->run($tenant, function () {
            $movement = InventoryMovement::query()->firstOrFail();
            try {
                $movement->forceFill(['delta' => 99])->save();
                $this->fail('update allowed');
            } catch (LogicException) {
            }
            $this->expectException(LogicException::class);
            $movement->delete();
        });
    }

    /** Architecture guard: no code outside InventoryService writes the ledger or on_hand. */
    #[Group('security')]
    public function test_only_inventory_service_writes_ledger(): void
    {
        $offenders = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(app_path()));
        foreach ($it as $file) {
            if (! $file->isFile() || $file->getExtension() !== 'php' || str_ends_with($file->getPathname(), 'Inventory/InventoryService.php')) {
                continue;
            }
            $code = (string) file_get_contents($file->getPathname());
            if (preg_match('/InventoryMovement::(query|withoutTenancy)\(\)[^;]*->(insert|update|delete|create)\(/s', $code)
                || preg_match('/->on_hand\s*=[^=>]/', $code)) {
                $offenders[] = str_replace(app_path(), 'app', $file->getPathname());
            }
        }
        $this->assertSame([], $offenders);
    }
}
