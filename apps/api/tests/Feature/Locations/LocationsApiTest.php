<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Billing\Models\Plan;
use App\Domain\Inventory\Models\Location;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8C §4, §9 locations CRUD + archive / unarchive / make-default (S179, S180, S181, P88C-17, P88C-18). */
#[Group('locations')]
class LocationsApiTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_every_new_store_has_one_default_main_warehouse(): void
    {
        [, , $store, $h] = $this->liveShop();

        $this->api($h, 'GET', $this->lUrl($store, '/locations'))->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Main warehouse')
            ->assertJsonPath('data.0.type', 'warehouse')
            ->assertJsonPath('data.0.is_default', true)
            ->assertJsonPath('data.0.archived_at', null)
            ->assertJsonPath('data.0.units_on_hand', 0)
            ->assertJsonPath('data.0.variants_count', 0);
    }

    public function test_create_update_list_with_stock_numbers_and_costs(): void
    {
        [, , $store, $h] = $this->growthShop();
        [, $variant] = $this->stocked($h, $store, stock: 7, variant: ['cost_amount' => 50000]);

        $shop = $this->addLocation($h, $store, 'Dhanmondi shop', 'shop', ['address' => 'Road 27']);
        $this->assertFalse($shop['is_default']);
        $this->assertSame(1, $shop['position']);
        $this->assertSame('Road 27', $shop['address']);

        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 3, 'location_id' => $shop['id']]])->assertOk();

        $this->api($h, 'PATCH', $this->lUrl($store, "/locations/{$shop['id']}"), ['name' => 'Dhanmondi outlet', 'type' => 'shop'])->assertOk()
            ->assertJsonPath('data.name', 'Dhanmondi outlet')
            ->assertJsonPath('data.units_on_hand', 3)
            ->assertJsonPath('data.stock_value_amount', 150000)
            ->assertJsonPath('data.variants_count', 1);

        $list = $this->api($h, 'GET', $this->lUrl($store, '/locations'))->assertOk()->json('data');
        $this->assertSame(['Main warehouse', 'Dhanmondi outlet'], array_column($list, 'name'));
        $this->assertSame([7, 3], array_column($list, 'units_on_hand'));

        // Staff: reads allowed, no cost value; writes 403 (settings.manage).
        [, $staff] = $this->member($store->tenant, TenantUser::ROLE_STAFF);
        $this->api($staff, 'GET', $this->lUrl($store, '/locations'))->assertOk()->assertJsonPath('data.0.stock_value_amount', null);
        $this->api($staff, 'POST', $this->lUrl($store, '/locations'), ['name' => 'X', 'type' => 'shop'])->assertForbidden();
        $this->api($staff, 'PATCH', $this->lUrl($store, "/locations/{$shop['id']}"), ['name' => 'X'])->assertForbidden();
        $this->api($staff, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/make-default"))->assertForbidden();
    }

    public function test_validation_and_unique_names(): void
    {
        [, , $store, $h] = $this->growthShop();

        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['type' => 'shop'])->assertUnprocessable()->assertJsonValidationErrors(['name'], 'error.details');
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => 'Hub', 'type' => 'kiosk'])->assertUnprocessable()->assertJsonValidationErrors(['type'], 'error.details');
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => str_repeat('a', 61), 'type' => 'shop'])->assertUnprocessable();
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => "Bad\x01name", 'type' => 'shop'])->assertUnprocessable();

        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => 'main WAREHOUSE', 'type' => 'shop'])
            ->assertUnprocessable()->assertJsonPath('error.code', 'location_name_taken');

        // An archived location frees its name.
        $old = $this->addLocation($h, $store, 'Old godown', 'warehouse');
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$old['id']}/archive"))->assertOk();
        $again = $this->addLocation($h, $store, 'Old godown', 'warehouse');
        // ...and unarchiving the first one now collides.
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$old['id']}/unarchive"))
            ->assertUnprocessable()->assertJsonPath('error.code', 'location_name_taken');
        $this->assertNotSame($old['id'], $again['id']);
    }

    public function test_pickup_address_link_prefills_the_address_and_must_be_of_the_store(): void
    {
        [, , $store, $h] = $this->growthShop();
        $pickup = $this->api($h, 'POST', $this->lUrl($store, '/pickup-locations'), ['name' => 'Mirpur', 'contact_name' => 'Rafi', 'phone' => '01711000008',
            'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'Section 10, Mirpur'])->assertCreated()->json('data.id');

        $loc = $this->addLocation($h, $store, 'Mirpur hub', 'warehouse', ['pickup_location_id' => $pickup]);
        $this->assertSame('Section 10, Mirpur', $loc['address']);
        $this->assertSame(['id' => $pickup, 'name' => 'Mirpur'], $loc['pickup_location']);

        [, , $other, $oh] = $this->growthShop('other');
        $foreign = $this->api($oh, 'POST', $this->lUrl($other, '/pickup-locations'), ['name' => 'Theirs', 'contact_name' => 'Rafi', 'phone' => '01711000009',
            'district_code' => 'dhaka', 'thana_code' => 'dhaka-dhanmondi', 'address_line' => 'Road 2'])->assertCreated()->json('data.id');
        $this->api($h, 'PATCH', $this->lUrl($store, "/locations/{$loc['id']}"), ['pickup_location_id' => $foreign])
            ->assertUnprocessable()->assertJsonValidationErrors(['pickup_location_id'], 'error.details');

        // Deleting the pickup address unlinks it (SET NULL), the location stays.
        $this->api($h, 'DELETE', $this->lUrl($store, "/pickup-locations/{$pickup}"))->assertSuccessful();
        $this->api($h, 'GET', $this->lUrl($store, '/locations'))->assertOk()->assertJsonPath('data.1.pickup_location', null)->assertJsonPath('data.1.address', 'Section 10, Mirpur');
    }

    /** S181: a 2nd active location needs multi_warehouse; downgrade keeps reads, adjust and archive. */
    public function test_plan_gate_on_second_location_and_unarchive(): void
    {
        [, $tenant, $store, $h] = $this->growthShop('starter', Plan::STARTER);

        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => 'Dhanmondi shop', 'type' => 'shop'])
            ->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        // Before validation, like the other plan gates.
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), [])->assertStatus(402);

        $this->planFor($tenant, Plan::GROWTH);
        $shop = $this->addLocation($h, $store);
        [, $variant] = $this->stocked($h, $store, stock: 2);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 4, 'location_id' => $shop['id']]])->assertOk();

        // Downgrade: still readable and adjustable; a 3rd location and unarchive are blocked; archive once empty.
        $this->planFor($tenant, Plan::STARTER);
        $this->api($h, 'GET', $this->lUrl($store, '/locations'))->assertOk()->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $this->lUrl($store, '/inventory?filter[location_id]='.$shop['id']))->assertOk()->assertJsonPath('data.0.on_hand', 4);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 0, 'location_id' => $shop['id']]], 'correction')->assertOk();
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => 'Hub', 'type' => 'warehouse'])->assertStatus(402);
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/archive"))->assertOk();
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/unarchive"))->assertStatus(402);
    }

    public function test_at_most_ten_active_locations(): void
    {
        [, , $store, $h] = $this->growthShop();
        for ($i = 2; $i <= Location::MAX_ACTIVE; $i++) {
            $this->addLocation($h, $store, "Shop {$i}");
        }
        $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => 'Shop 11', 'type' => 'shop'])
            ->assertUnprocessable()->assertJsonPath('error.code', 'limit_reached');
    }

    /** P88C-17 archive rules with the reasons; P88C-5 make-default. */
    public function test_archive_reasons_and_make_default(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        $shop = $this->addLocation($h, $store);
        [, $variant] = $this->stocked($h, $store, stock: 5);

        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$main->id}/archive"))
            ->assertStatus(409)->assertJsonPath('error.code', 'location_in_use')->assertJsonPath('error.details.reasons', ['is_default', 'has_stock']);

        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $shop['id']]])->assertOk();
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/archive"))
            ->assertStatus(409)->assertJsonPath('error.details.reasons', ['has_stock']);
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'set', 'quantity' => 0, 'location_id' => $shop['id']]], 'correction')->assertOk();

        // An open purchase order receiving there blocks the archive too.
        $supplier = $this->api($h, 'POST', $this->lUrl($store, '/suppliers'), ['name' => 'Rahman Fabrics'])->assertCreated()->json('data.id');
        $po = $this->api($h, 'POST', $this->lUrl($store, '/purchase-orders'), ['supplier_id' => $supplier, 'location_id' => $shop['id'],
            'lines' => [['variant_id' => $variant, 'unit_cost_amount' => 100, 'quantity' => 2]]])->assertCreated()->json('data.id');
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/archive"))
            ->assertStatus(409)->assertJsonPath('error.details.reasons', ['open_purchase_orders']);
        $this->api($h, 'DELETE', $this->lUrl($store, "/purchase-orders/{$po}"))->assertNoContent();

        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/archive"))->assertOk()->assertJsonPath('data.archived_at', fn ($v) => $v !== null);
        // Archived → can't become the default, adjust there or be a filter target.
        $this->makeDefault($h, $store, $shop['id'])->assertUnprocessable()->assertJsonPath('error.code', 'location_archived');
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $shop['id']]])
            ->assertUnprocessable()->assertJsonPath('error.code', 'location_archived');
        $this->api($h, 'GET', $this->lUrl($store, '/locations?filter[archived]=1'))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->lUrl($store, '/locations?filter[archived]=0'))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->lUrl($store, '/locations'))->assertOk()->assertJsonCount(2, 'data');

        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$shop['id']}/unarchive"))->assertOk()->assertJsonPath('data.archived_at', null);
        $this->makeDefault($h, $store, $shop['id'])->assertOk()->assertJsonPath('data.is_default', true);
        $list = $this->api($h, 'GET', $this->lUrl($store, '/locations'))->json('data');
        $this->assertSame([$shop['id'], $main->id], array_column($list, 'id'));
        $this->assertSame([true, false], array_column($list, 'is_default'));

        $actions = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', 'location.%')->orderBy('created_at')->orderBy('id')->pluck('action')->all();
        foreach (['location.created', 'location.archived', 'location.unarchived', 'location.made_default'] as $a) {
            $this->assertContains($a, $actions);
        }
        $subject = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'location.made_default')->value('subject_type');
        $this->assertSame('location', $subject);
    }

    /** S179: another tenant's or store's location → 404 in the path; 422 in a body / filter. */
    public function test_isolation(): void
    {
        [, $tenantA, $storeA, $hA] = $this->growthShop('a');
        [, $tenantB, $storeB, $hB] = $this->growthShop('b');
        $theirs = $this->addLocation($hB, $storeB, 'Their shop');

        $this->assertTenantIsolation($hA, [
            ['PATCH', $this->lUrl($storeA, "/locations/{$theirs['id']}"), ['name' => 'Mine']],
            ['POST', $this->lUrl($storeA, "/locations/{$theirs['id']}/archive")],
            ['POST', $this->lUrl($storeA, "/locations/{$theirs['id']}/unarchive")],
            ['POST', $this->lUrl($storeA, "/locations/{$theirs['id']}/make-default")],
        ]);
        // Tenant A can't reach store B's URL at all.
        $this->api($hA, 'GET', $this->lUrl($storeB, '/locations'))->assertNotFound();

        [, $variant] = $this->stocked($hA, $storeA, stock: 1);
        $this->adjustAt($hA, $storeA, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 1, 'location_id' => $theirs['id']]])
            ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonValidationErrors(['items.0.location_id'], 'error.details');
        $this->api($hA, 'GET', $this->lUrl($storeA, '/inventory?filter[location_id]='.$theirs['id']))->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->api($hA, 'GET', $this->lUrl($storeA, '/inventory/movements?filter[location_id]='.$theirs['id']))->assertUnprocessable();
        $this->api($hA, 'PATCH', $this->lUrl($storeA, "/inventory/{$variant}"), ['low_stock_threshold' => 2, 'location_id' => $theirs['id']])->assertUnprocessable();
        $supplier = $this->api($hA, 'POST', $this->lUrl($storeA, '/suppliers'), ['name' => 'Rahman Fabrics'])->assertCreated()->json('data.id');
        $this->api($hA, 'POST', $this->lUrl($storeA, '/purchase-orders'), ['supplier_id' => $supplier, 'location_id' => $theirs['id'],
            'lines' => [['variant_id' => $variant, 'unit_cost_amount' => 100, 'quantity' => 2]]])->assertUnprocessable();

        $this->assertStoreIsolation(Location::class, $tenantA, $storeA, $storeB);
        $this->assertStoreIsolation(Location::class, $tenantB, $storeB, $storeA);
    }
}
