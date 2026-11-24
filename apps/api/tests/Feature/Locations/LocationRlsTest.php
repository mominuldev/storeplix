<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** S179 at the database (PHASE-8-8C §3.1): `locations` is under forced RLS. TENANCY_RLS=true on Postgres only. */
#[Group('locations')]
#[Group('rls')]
#[Group('security')]
class LocationRlsTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    public function test_locations_are_isolated(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpLocations();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->growthShop($slug);
            [, $variant] = $this->stocked($h, $store, stock: 2);
            $loc = $this->addLocation($h, $store, 'Shop '.$slug);
            $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $loc['id']]])->assertOk();
            $shops[$slug] = [$tenant, $store];
        }
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB] = $shops['beta'];

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenantA->id]);
        foreach (['locations', 'inventories', 'inventory_movements'] as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into locations (id, tenant_id, store_id, name, type, is_default, position, created_at, updated_at) values (?, ?, ?, 'Sneaky', 'shop', false, 9, now(), now())",
                [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused);

        DB::statement("select set_config('app.tenant_id', '', false)");
        $this->assertSame(0, (int) DB::selectOne('select count(*) as c from locations')->c);
    }
}
