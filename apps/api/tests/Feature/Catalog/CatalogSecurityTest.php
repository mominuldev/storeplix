<?php

namespace Tests\Feature\Catalog;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Catalog\Models\Product;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Tenancy\Models\TenantUser;
use Database\Seeders\PlanSeeder;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** Phase 4 security group (§10/§12): mass assignment, price manipulation, staff cost/PII, plan and stock races. */
#[Group('security')]
class CatalogSecurityTest extends TestCase
{
    use CatalogFixtures, ForksRaces, RefreshDatabase;

    public function test_mass_assignment_probes_have_no_effect(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, , $other] = $this->shop();
        $probe = [
            'tenant_id' => $other->tenant_id, 'store_id' => $other->id, 'price_min_amount' => 1, 'price_max_amount' => 1,
            'revision' => 77, 'published_at' => '2020-01-01T00:00:00Z', 'currency' => 'USD', 'type' => 'variable', 'id' => '01jzzzzzzzzzzzzzzzzzzzzzzz',
        ];
        $p = $this->createProduct($h, $store, $probe + $this->simpleProduct(variant: ['on_hand' => 500, 'committed' => 9, 'tenant_id' => $other->tenant_id, 'product_id' => 'x']));
        $this->assertSame(1, $p['revision']);
        $this->assertSame(150000, $p['price_min_amount']);
        $this->assertNull($p['published_at']);
        $this->assertSame('BDT', $p['currency']);
        $this->assertSame('simple', $p['type']);
        $this->assertNotSame('01jzzzzzzzzzzzzzzzzzzzzzzz', $p['id']);
        $this->assertSame(0, $p['variants'][0]['inventory']['on_hand']);
        $this->assertSame(0, $p['variants'][0]['inventory']['committed']);
        $row = Product::withoutTenancy()->find($p['id']);
        $this->assertSame($tenant->id, $row->tenant_id);
        $this->assertSame($store->id, $row->store_id);

        $this->api($h, 'PATCH', "/api/v1/stores/{$store->id}/products/{$p['id']}", ['revision' => 1] + $probe)->assertOk()
            ->assertJsonPath('data.revision', 2)->assertJsonPath('data.price_min_amount', 150000)->assertJsonPath('data.currency', 'BDT');

        $c = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", [
            'name' => 'C', 'phone' => '01711111111', 'orders_count' => 9, 'total_spent_amount' => 9, 'source' => 'storefront',
            'revision' => 5, 'store_id' => $other->id, 'last_order_at' => '2020-01-01',
        ])->assertCreated()->json('data');
        $this->assertSame([0, 0, 'manual', 1, null], [$c['orders_count'], $c['total_spent_amount'], $c['source'], $c['revision'], $c['last_order_at']]);
    }

    public function test_price_manipulation_is_rejected(): void
    {
        [, , $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/products";
        foreach ([-1, 1.5, '100', null, 1_000_000_001] as $bad) {
            $this->api($h, 'POST', $url, ['name' => 'X', 'variants' => [['price_amount' => $bad]]])->assertStatus(422);
        }
        $this->api($h, 'POST', $url, $this->simpleProduct(variant: ['compare_at_amount' => 1]))->assertStatus(422);
        $this->api($h, 'POST', $url, $this->simpleProduct(variant: ['cost_amount' => -5]))->assertStatus(422);
        if (DB::getDriverName() === 'pgsql') {
            // Needs a row: on an empty table the UPDATE touches nothing and the CHECK never fires.
            $this->api($h, 'POST', $url, $this->simpleProduct())->assertCreated();
            $this->expectException(QueryException::class);
            $this->platformTable('product_variants')->update(['compare_at_amount' => 0]);
        }
    }

    public function test_staff_never_sees_or_writes_cost(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $p = $this->createProduct($h, $store, $this->simpleProduct(variant: ['cost_amount' => 90000]));
        $url = "/api/v1/stores/{$store->id}/products";

        $this->api($staffH, 'GET', "{$url}/{$p['id']}")->assertJsonPath('data.cost_amount', null)->assertJsonPath('data.variants.0.cost_amount', null);
        $this->api($staffH, 'GET', $url)->assertJsonPath('data.0.cost_amount', null);
        // Staff PATCH without cost keeps it; with cost is ignored.
        $variant = $p['variants'][0]['id'];
        $this->api($staffH, 'PATCH', "{$url}/{$p['id']}", ['revision' => 1, 'variants' => [['id' => $variant, 'price_amount' => 160000, 'cost_amount' => 1]]])->assertOk();
        $this->api($h, 'GET', "{$url}/{$p['id']}")->assertJsonPath('data.variants.0.cost_amount', 90000)->assertJsonPath('data.price_amount', 160000);
        $created = $this->createProduct($staffH, $store, $this->simpleProduct('Staff made', variant: ['cost_amount' => 5]));
        $this->api($h, 'GET', "{$url}/{$created['id']}")->assertJsonPath('data.variants.0.cost_amount', null);
        // PII: staff see customer phone/email (P4-15) but cannot delete/export.
        $c = $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'C', 'phone' => '01711111111', 'email' => 'c@x.test'])->json('data');
        $this->api($staffH, 'GET', "/api/v1/stores/{$store->id}/customers/{$c['id']}")->assertJsonPath('data.phone', '8801711111111')->assertJsonPath('data.email', 'c@x.test');
        $this->api($staffH, 'DELETE', "/api/v1/stores/{$store->id}/customers/{$c['id']}")->assertForbidden();
        $this->api($staffH, 'DELETE', "{$url}/{$p['id']}")->assertForbidden();
        $this->api($staffH, 'POST', "/api/v1/stores/{$store->id}/exports", ['type' => 'customers'])->assertForbidden();
    }

    /** Postgres only: two connections race at limit − 1; exactly one create succeeds. */
    #[Group('race')]
    public function test_plan_limit_race(): void
    {
        if (DB::getDriverName() !== 'pgsql' || ! function_exists('pcntl_fork')) {
            $this->markTestSkipped('Needs Postgres + pcntl (CI perf/security job).');
        }
        try {
            $this->seed(PlanSeeder::class);
            [, $tenant, $store, $h] = $this->shop();
            $this->tenancy()->run($tenant, function () use ($store) {
                Subscription::query()->update(['plan_id' => Plan::query()->where('code', Plan::FREE)->value('id'), 'status' => Subscription::ACTIVE]);
                for ($i = 0; $i < 99; $i++) {
                    $p = new Product(['name' => "P{$i}", 'slug' => "p-{$i}", 'type' => 'simple', 'currency' => 'BDT']);
                    $p->store_id = $store->id;
                    $p->save();
                }
            });
            FeatureGate::forget($tenant->id);
            $statuses = $this->parallel(2, fn () => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/products", $this->simpleProduct())->status());
            sort($statuses);
            $this->assertSame([201, 402], $statuses);
        } finally {
            $this->raceCleanup();
        }
    }

    /** Postgres only (§12 inventory concurrency): 50 × −1 on stock 50 → 0, 50 ledger rows, never negative. */
    #[Group('perf')]
    #[Group('race')]
    public function test_parallel_adjustments_never_go_negative(): void
    {
        if (DB::getDriverName() !== 'pgsql' || ! function_exists('pcntl_fork')) {
            $this->markTestSkipped('Needs Postgres + pcntl (CI perf job).');
        }
        try {
            [, $tenant, $store, $h] = $this->shop();
            $p = $this->createProduct($h, $store, $this->simpleProduct(variant: ['initial_on_hand' => 50]));
            $variant = $p['variants'][0]['id'];
            $statuses = $this->parallel(55, fn () => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments", [
                'reason' => 'lost', 'items' => [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => -1]],
            ])->status());
            $this->assertSame(50, count(array_filter($statuses, fn ($s) => $s === 200)));
            $this->assertSame(0, Inventory::withoutTenancy()->where('variant_id', $variant)->value('on_hand'));
            $this->assertSame(50, InventoryMovement::withoutTenancy()->where('variant_id', $variant)->where('reason', 'lost')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
