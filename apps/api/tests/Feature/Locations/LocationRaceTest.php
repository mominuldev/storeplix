<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\Location;
use App\Domain\Orders\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** PHASE-8-8C S183 (Postgres races): checkout never commits more than the ONLINE location's available stock. */
#[Group('locations')]
#[Group('race')]
class LocationRaceTest extends TestCase
{
    use ForksRaces, LocationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_parallel_checkouts_sell_only_the_online_locations_stock(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, $store, $h] = $this->growthShop();
            [, $variant] = $this->stocked($h, $store, 1000, 3);
            $shop = $this->addLocation($h, $store);
            $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 50, 'location_id' => $shop['id']]])->assertOk();
            $carts = [];
            for ($i = 0; $i < 10; $i++) {
                $carts[] = $this->cartWith($store, $variant);
            }

            $results = $this->parallel(10, fn (int $i) => $this->checkout($store, $carts[$i], $this->checkoutBody(8000, ['contact' => ['phone' => sprintf('0171500%04d', $i)]]))->status());

            $this->assertSame(3, count(array_filter($results, fn ($s) => $s === 201)), json_encode($results));
            $this->assertSame(7, count(array_filter($results, fn ($s) => $s === 422)), json_encode($results));
            $this->assertSame(3, Order::withoutTenancy()->where('store_id', $store->id)->count());
            $main = Location::withoutTenancy()->where('store_id', $store->id)->where('is_default', true)->value('id');
            $this->assertSame(3, Inventory::withoutTenancy()->where('variant_id', $variant)->where('location_id', $main)->value('committed'));
            $this->assertSame(0, Inventory::withoutTenancy()->where('variant_id', $variant)->where('location_id', $shop['id'])->value('committed'));
        } finally {
            $this->raceCleanup();
        }
    }

    /** The 10-location cap and the single default hold under parallel creates / make-default. */
    public function test_parallel_location_writes_keep_the_cap_and_one_default(): void
    {
        $this->requirePostgresRace();
        try {
            [, , $store, $h] = $this->growthShop();
            for ($i = 2; $i <= Location::MAX_ACTIVE - 1; $i++) {
                $this->addLocation($h, $store, "Shop {$i}");
            }
            $results = $this->parallel(4, fn (int $i) => $this->api($h, 'POST', $this->lUrl($store, '/locations'), ['name' => "Race {$i}", 'type' => 'shop'])->status());
            $this->assertSame(1, count(array_filter($results, fn ($s) => $s === 201)), json_encode($results));
            $this->assertSame(Location::MAX_ACTIVE, Location::withoutTenancy()->where('store_id', $store->id)->whereNull('archived_at')->count());

            $ids = Location::withoutTenancy()->where('store_id', $store->id)->where('is_default', false)->orderBy('id')->limit(4)->pluck('id')->all();
            $results = $this->parallel(4, fn (int $i) => $this->makeDefault($h, $store, $ids[$i])->status());
            $this->assertSame([200, 200, 200, 200], $results, json_encode($results));
            $this->assertSame(1, Location::withoutTenancy()->where('store_id', $store->id)->where('is_default', true)->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
