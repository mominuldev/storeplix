<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\TestCase;

/**
 * PHASE-8-8C S182: on a seeded pre-8.8c fixture (the six `2026_12_07_*` migrations rolled back), migrating creates one
 * default "Main warehouse" per store (linked to the default pickup address) and gives every inventory, movement,
 * tracked order line, PO and receipt row that location; Σ on_hand per variant is unchanged. A negative on_hand aborts
 * the migration with a clear message.
 *
 * Runs inside the test transaction (DDL is transactional on sqlite and Postgres), so the schema is restored after.
 * Not in RLS mode: there migrations run on the owner connection, outside the app session.
 */
#[Group('locations')]
class LocationBackfillMigrationTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    /** The first 8.8c migration: the rollback undoes it and every migration after it (8.8c part B, amendment A1, …). */
    private const FIRST = '2026_12_07_000100';

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
        if ($this->rlsActive()) {
            $this->markTestSkipped('Migration fixture test runs on sqlite / owner Postgres (api-postgres), not in RLS mode.');
        }
    }

    /** @return array{0: string, 1: list<string>} store id, variant ids */
    private function seedFixture(): array
    {
        [, , $store, $h] = $this->growthShop();
        $this->api($h, 'POST', $this->lUrl($store, '/pickup-locations'), ['name' => 'Mirpur', 'contact_name' => 'Rafi', 'phone' => '01711000008',
            'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'Section 10, Mirpur'])->assertCreated();
        [, $a] = $this->stocked($h, $store, stock: 9);
        [, $b] = $this->stocked($h, $store, stock: 4);
        [, $untracked] = $this->stocked($h, $store, stock: 0, variant: ['track_inventory' => false]);
        $body = $this->manualBody($a, 2);
        $body['items'][] = ['variant_id' => $untracked, 'quantity' => 1];
        $this->manual($h, $store, $body)->assertCreated();
        $this->adjustAt($h, $store, [['variant_id' => $b, 'mode' => 'delta', 'quantity' => 3]])->assertOk();
        $supplier = $this->api($h, 'POST', $this->lUrl($store, '/suppliers'), ['name' => 'Rahman Fabrics'])->assertCreated()->json('data.id');
        $po = $this->api($h, 'POST', $this->lUrl($store, '/purchase-orders'), ['supplier_id' => $supplier,
            'lines' => [['variant_id' => $a, 'unit_cost_amount' => 100, 'quantity' => 5]]])->assertCreated()->json('data');
        $this->api($h, 'POST', $this->lUrl($store, "/purchase-orders/{$po['id']}/mark-ordered"))->assertOk();
        $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->lUrl($store, "/purchase-orders/{$po['id']}/receipts"),
            ['lines' => [['item_id' => $po['lines'][0]['id'], 'received' => 2, 'damaged' => 0]]])->assertCreated();

        return [$store->id, [$a, $b, $untracked]];
    }

    private function rollBack(): void
    {
        $steps = count(array_filter(glob(database_path('migrations/*.php')) ?: [], fn (string $f) => strcmp(basename($f), self::FIRST) >= 0));
        $this->artisan('migrate:rollback', ['--step' => $steps])->assertSuccessful();
        $this->assertFalse(Schema::hasTable('locations'));
        foreach (['inventories', 'inventory_movements', 'order_items', 'purchase_orders', 'purchase_receipts'] as $table) {
            $this->assertFalse(Schema::hasColumn($table, 'location_id'), "{$table}.location_id after rollback");
        }
    }

    public function test_backfill_gives_every_row_the_default_location_and_keeps_totals(): void
    {
        [$storeId, $variants] = $this->seedFixture();
        $this->rollBack();
        $before = DB::table('inventories')->groupBy('variant_id')->selectRaw('variant_id, sum(on_hand) as s')->pluck('s', 'variant_id')->map(fn ($v) => (int) $v)->all();
        $this->assertSame(['received'], array_values(array_unique(DB::table('inventory_movements')->where('reason', 'received')->pluck('reason')->all())));

        $this->artisan('migrate')->assertSuccessful();

        $locations = DB::table('locations')->where('store_id', $storeId)->get();
        $this->assertCount(1, $locations);
        $default = $locations->first();
        $this->assertSame('Main warehouse', $default->name);
        $this->assertSame('warehouse', $default->type);
        $this->assertTrue((bool) $default->is_default);
        $this->assertSame('Section 10, Mirpur', $default->address);
        $this->assertSame(DB::table('pickup_locations')->where('store_id', $storeId)->where('is_default', true)->value('id'), $default->pickup_location_id);

        foreach (['inventories', 'inventory_movements', 'purchase_orders', 'purchase_receipts'] as $table) {
            $this->assertSame(0, DB::table($table)->whereNull('location_id')->count(), "{$table} rows without a location");
            $this->assertSame([$default->id], DB::table($table)->distinct()->pluck('location_id')->all(), $table);
        }
        $this->assertSame([$default->id], DB::table('order_items')->where('tracked', true)->distinct()->pluck('location_id')->all());
        $this->assertSame([null], DB::table('order_items')->where('tracked', false)->distinct()->pluck('location_id')->all());

        $after = DB::table('inventories')->groupBy('variant_id')->selectRaw('variant_id, sum(on_hand) as s')->pluck('s', 'variant_id')->map(fn ($v) => (int) $v)->all();
        ksort($before);
        ksort($after);
        $this->assertSame($before, $after);
        $this->assertSame(count($variants), count($after));

        // The app keeps working on the migrated data: the committed order line releases at the stored location.
        $this->assertSame(2, (int) DB::table('inventories')->where('variant_id', $variants[0])->value('committed'));
    }

    public function test_negative_on_hand_aborts_with_a_clear_message(): void
    {
        $this->seedFixture();
        $this->rollBack();
        DB::table('inventories')->limit(1)->update(['on_hand' => -1]);

        try {
            $this->artisan('migrate');
            $this->fail('The migration should abort.');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('on_hand < 0', $e->getMessage());
        }
    }
}
