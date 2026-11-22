<?php

namespace Tests\Feature\Commerce;

use App\Domain\Geo\BdGeo;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Shipping\ZoneResolver;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/** §3.1 geo and §3.5 shipping (P5-7..P5-10). */
class ShippingGeoTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    public function test_geo_dataset_is_consistent_and_cacheable(): void
    {
        $geo = app(BdGeo::class)->all();
        $this->assertCount(8, $geo['divisions']);
        $this->assertCount(64, $geo['districts']);
        $districts = array_column($geo['districts'], null, 'code');
        $divisions = array_column($geo['divisions'], null, 'code');
        foreach ($geo['districts'] as $d) {
            $this->assertArrayHasKey($d['division_code'], $divisions);
        }
        foreach ($geo['thanas'] as $t) {
            $this->assertArrayHasKey($t['district_code'], $districts, $t['code']);
            $this->assertMatchesRegularExpression('/^[a-z0-9-]{1,48}$/', $t['code']);
            $this->assertNotSame('', $t['name_bn']);
        }
        $codes = array_column($geo['thanas'], 'code');
        $this->assertSame(count($codes), count(array_unique($codes)));
        $this->assertSame(count($geo['districts']), count($districts));
        $this->assertCount(50, app(BdGeo::class)->cityThanas('dhaka'));
        $this->assertContains('dhaka-dhanmondi', $codes);

        $etag = $this->getJson('/api/v1/geo/bd')->assertOk()
            ->assertHeader('Cache-Control', 'max-age=86400, public')
            ->assertJsonStructure(['data' => ['version', 'divisions' => [['code', 'name', 'name_bn']], 'districts' => [['code', 'division_code', 'name', 'name_bn']], 'thanas' => [['code', 'district_code', 'name', 'name_bn', 'is_city']]]])
            ->headers->get('ETag');
        $this->assertSame('"bd-'.$geo['version'].'"', $etag);
        $this->get('/api/v1/geo/bd', ['If-None-Match' => $etag])->assertStatus(304);
    }

    public function test_defaults_full_replace_and_area_rules(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $url = "/api/v1/stores/{$store->id}/shipping";
        $this->api($h, 'GET', $url)->assertOk()->assertJsonPath('data.configured', false)->assertJsonPath('data.zones', []);

        $inside = ['name' => 'Inside Dhaka', 'kind' => 'custom', 'charge_amount' => 7000, 'min_days' => 1, 'max_days' => 2,
            'areas' => [['district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur'], ['district_code' => 'dhaka', 'thana_code' => 'dhaka-gulshan']]];
        $fallback = ['name' => 'Outside Dhaka', 'kind' => 'fallback', 'charge_amount' => 13000, 'min_days' => 2, 'max_days' => 4];
        $this->api($h, 'PUT', $url, ['zones' => [$inside], 'free_delivery_over_amount' => null])->assertStatus(422)
            ->assertJsonPath('error.details.zones.0', 'Keep one fallback zone for everywhere else.');
        $this->api($h, 'PUT', $url, ['zones' => [$inside, $fallback, $fallback], 'free_delivery_over_amount' => null])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['zones' => [$inside, ['name' => 'Mirpur', 'kind' => 'custom', 'charge_amount' => 5000, 'min_days' => 1, 'max_days' => 1,
            'areas' => [['district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur']]], $fallback], 'free_delivery_over_amount' => null])
            ->assertStatus(422)->assertJsonPath('error.details', ['zones.1.areas.0' => ['Mirpur is already in Inside Dhaka.']]);
        $this->api($h, 'PUT', $url, ['zones' => [['areas' => [['district_code' => 'nowhere']]] + $inside, $fallback], 'free_delivery_over_amount' => null])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['zones' => [$inside, ['is_active' => false] + $fallback], 'free_delivery_over_amount' => null])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['zones' => [['min_days' => 3, 'max_days' => 2] + $inside, $fallback], 'free_delivery_over_amount' => null])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['zones' => [['charge_amount' => 10.5] + $inside, $fallback], 'free_delivery_over_amount' => null])->assertStatus(422);

        $saved = $this->api($h, 'PUT', $url, ['zones' => [$inside, $fallback], 'free_delivery_over_amount' => 300000])->assertOk()
            ->assertJsonPath('data.configured', true)->assertJsonPath('data.free_delivery_over_amount', 300000)
            ->assertJsonPath('data.zones.0.area_summary', 'Dhaka city · 2 thanas')
            ->assertJsonPath('data.zones.1.area_summary', 'Everywhere else')
            ->json('data.zones');
        // ids keep rows; a zone missing from the payload is deleted
        $gazipur = ['name' => 'Gazipur', 'kind' => 'custom', 'charge_amount' => 9000, 'min_days' => 1, 'max_days' => 3, 'areas' => [['district_code' => 'gazipur']]];
        $again = $this->api($h, 'PUT', $url, ['zones' => [$gazipur, ['id' => $saved[1]['id']] + $fallback], 'free_delivery_over_amount' => null])->assertOk()->json('data.zones');
        $this->assertSame($saved[1]['id'], $again[1]['id']);
        $this->assertSame('Gazipur (whole district)', $again[0]['areas'][0]['label']);
        $this->assertSame(2, ShippingZone::withoutTenancy()->count());
        $this->api($h, 'PUT', $url, ['zones' => [['id' => '01jzzzzzzzzzzzzzzzzzzzzzzz'] + $gazipur, $fallback], 'free_delivery_over_amount' => null])->assertStatus(422)
            ->assertJsonPath('error.details', ['zones.0.id' => ['Unknown zone.']]);
    }

    public function test_resolution_thana_beats_district_beats_fallback(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/shipping", ['zones' => [
            ['name' => 'Savar', 'kind' => 'custom', 'charge_amount' => 6000, 'min_days' => 1, 'max_days' => 1, 'areas' => [['district_code' => 'dhaka', 'thana_code' => 'dhaka-savar']]],
            ['name' => 'Dhaka district', 'kind' => 'custom', 'charge_amount' => 8000, 'min_days' => 1, 'max_days' => 2, 'areas' => [['district_code' => 'dhaka']]],
            ['name' => 'Gazipur (off)', 'kind' => 'custom', 'charge_amount' => 1, 'min_days' => 1, 'max_days' => 2, 'is_active' => false, 'areas' => [['district_code' => 'gazipur']]],
            ['name' => 'Everywhere', 'kind' => 'fallback', 'charge_amount' => 15000, 'min_days' => 2, 'max_days' => 5],
        ], 'free_delivery_over_amount' => 100000])->assertOk();

        $this->tenancy()->run($tenant, function () use ($store) {
            $r = app(ZoneResolver::class);
            $this->assertSame('Savar', $r->resolve($store->id, 'dhaka', 'dhaka-savar')->name);
            $this->assertSame('Dhaka district', $r->resolve($store->id, 'dhaka', 'dhaka-dhanmondi')->name);
            $this->assertSame('Everywhere', $r->resolve($store->id, 'gazipur', 'gazipur-kaliakair')->name); // inactive falls through
            $this->assertSame('Everywhere', $r->resolve($store->id, 'sylhet', 'sylhet-sylhet-sadar')->name);
            $this->assertSame(0, $r->quote($store->id, 'sylhet', 'sylhet-sylhet-sadar', 100000)['amount']); // at threshold
            $this->assertSame(15000, $r->quote($store->id, 'sylhet', 'sylhet-sylhet-sadar', 99999)['amount']);
        });
    }

    public function test_pickup_locations_and_permissions(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $base = "/api/v1/stores/{$store->id}/pickup-locations";
        $body = ['name' => 'Warehouse', 'district_code' => 'dhaka', 'thana_code' => 'dhaka-mirpur', 'address_line' => 'Section 10, Road 3', 'contact_phone' => '01712345678'];
        $first = $this->api($h, 'POST', $base, $body)->assertCreated()->assertJsonPath('data.is_default', true)
            ->assertJsonPath('data.thana', 'Mirpur')->assertJsonPath('data.contact_phone', '8801712345678')->json('data');
        $second = $this->api($h, 'POST', $base, ['name' => 'Shop'] + $body)->assertCreated()->assertJsonPath('data.is_default', false)->json('data');
        $this->api($h, 'POST', $base, ['thana_code' => 'gazipur-kaliakair'] + $body)->assertStatus(422);
        $this->api($h, 'PATCH', "{$base}/{$second['id']}", ['is_default' => true])->assertOk()->assertJsonPath('data.is_default', true);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipping")->assertJsonPath('data.pickup_locations.0.id', $second['id']);
        $this->api($h, 'DELETE', "{$base}/{$second['id']}")->assertNoContent();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipping")->assertJsonPath('data.pickup_locations.0.is_default', true)
            ->assertJsonPath('data.pickup_locations.0.id', $first['id']);
        for ($i = 0; $i < 9; $i++) {
            $this->api($h, 'POST', $base, $body)->assertCreated();
        }
        $this->api($h, 'POST', $base, $body)->assertStatus(409)->assertJsonPath('error.message', 'You can add up to 10 pickup addresses.');

        $this->api($staff, 'GET', "/api/v1/stores/{$store->id}/shipping")->assertOk();
        $this->api($staff, 'PUT', "/api/v1/stores/{$store->id}/shipping", ['zones' => [], 'free_delivery_over_amount' => null])->assertForbidden();
        $this->api($staff, 'POST', $base, $body)->assertForbidden();
    }

    public function test_backfill_command_is_idempotent(): void
    {
        [, , $store, $h] = $this->shop();
        $this->artisan('shipping:provision-defaults')->assertSuccessful();
        $this->artisan('shipping:provision-defaults')->assertSuccessful();
        $zones = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/shipping")->assertJsonPath('data.configured', true)->json('data.zones');
        $this->assertSame(['Inside Dhaka', 'Outside Dhaka'], array_column($zones, 'name'));
        $this->assertSame([7000, 13000], array_column($zones, 'charge_amount'));
        $this->assertSame('Dhaka city · 50 thanas', $zones[0]['area_summary']);
    }
}
