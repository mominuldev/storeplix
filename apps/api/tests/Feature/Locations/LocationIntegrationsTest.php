<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Automations\Mail\LowStockMail;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\Location;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Developer\ApiKeys\ApiKeyFixtures;
use Tests\Feature\Developer\Webhooks\WebhookFixtures;
use Tests\TestCase;

/**
 * PHASE-8-8C §5.4 external inventory (online numbers on top, `locations[]`, `location_id` filter and adjust), P88C-15
 * `stock.low` per location row with `location {id, name}` and the low-stock alert text "at {location}".
 */
#[Group('locations')]
class LocationIntegrationsTest extends TestCase
{
    use ApiKeyFixtures, RefreshDatabase, WebhookFixtures {
        ApiKeyFixtures::liveShop insteadof WebhookFixtures;
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpWebhooks();
        config(['webhooks_out.fake' => true]);
    }

    private function addLocation(array $h, $store, string $name): string
    {
        return $this->api($h, 'POST', "/api/v1/stores/{$store->id}/locations", ['name' => $name, 'type' => 'shop'])->assertCreated()->json('data.id');
    }

    public function test_external_inventory_shape_filter_and_adjust(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [, $variant] = $this->stocked($h, $store, 100000, 5, ['sku' => 'INV-1']);
        $shop = $this->addLocation($h, $store, 'Dhanmondi shop');
        [, $plain] = $this->createKey($h, ['inventory:write'], 'Stock sync');
        $base = "/stores/{$store->id}";

        // External adjust with a location (ledger actor = the key).
        $this->extWrite($plain, 'POST', "{$base}/inventory/adjustments", ['reason' => 'received', 'items' => [
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 3, 'location_id' => $shop],
        ]])->assertOk()->assertJsonPath('data.movements.0.location.id', $shop)->assertJsonPath('data.movements.0.actor.type', 'api_key');

        // Top-level numbers = the ONLINE location; location_id null; locations[] per location.
        foreach (["{$base}/inventory", "{$base}/inventory?filter[sku]=INV-1"] as $url) {
            $this->ext($plain, 'GET', $url)->assertOk()
                ->assertJsonPath('data.0.on_hand', 5)->assertJsonPath('data.0.location_id', null)
                ->assertJsonPath('data.0.locations.0.on_hand', 5)->assertJsonPath('data.0.locations.1', ['id' => $shop, 'name' => 'Dhanmondi shop', 'on_hand' => 3, 'committed' => 0, 'available' => 3]);
        }
        foreach (["{$base}/inventory?filter[location_id]={$shop}", "{$base}/inventory?filter[sku]=INV-1&filter[location_id]={$shop}"] as $url) {
            $this->ext($plain, 'GET', $url)->assertOk()->assertJsonPath('data.0.on_hand', 3)->assertJsonPath('data.0.location_id', $shop);
        }
        // The merchant "All locations" list is the total.
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/inventory")->assertOk()->assertJsonPath('data.0.on_hand', 8);
    }

    public function test_stock_low_fires_per_location_row_with_the_location(): void
    {
        [, $tenant, $store, $h] = $this->devShop();
        [, $variant] = $this->stocked($h, $store, 100000, 20);
        $this->endpointId($h, $store, ['stock.low']);
        $shop = $this->addLocation($h, $store, 'Dhanmondi shop');
        $adjust = fn (array $item) => $this->api($h, 'POST', "/api/v1/stores/{$store->id}/inventory/adjustments", ['reason' => 'lost', 'items' => [$item]])->assertOk();

        $adjust(['variant_id' => $variant, 'mode' => 'set', 'quantity' => 8, 'location_id' => $shop]);
        $this->assertCount(0, $this->deliveriesOf($tenant, 'stock.low'));
        $adjust(['variant_id' => $variant, 'mode' => 'set', 'quantity' => 2, 'location_id' => $shop]); // 8 → 2 at the shop: crosses there
        $rows = $this->deliveriesOf($tenant, 'stock.low');
        $this->assertCount(1, $rows);
        $object = $rows->first()->payload['data']['object'];
        $this->assertSame(['id' => $shop, 'name' => 'Dhanmondi shop'], $object['location']);
        $this->assertSame(2, $object['on_hand']);
        $this->assertSame($shop, $object['location_id']);
        $this->assertSame('low_stock', $object['status']);

        // Low-stock alert text names the location when the store has more than one.
        $rowId = $this->inTenant($tenant, fn () => Inventory::query()->where('variant_id', $variant)->where('location_id', $shop)->value('id'));
        $subject = $this->inTenant($tenant, fn () => Subject::load($store, 'inventory', $rowId));
        $this->assertSame('Dhanmondi shop', $subject->context['location_name']);
        $mail = new LowStockMail('Shop', 'Panjabi', null, 2, 'https://x.test', $subject->context['location_name']);
        $this->assertStringEndsWith('2 left at Dhanmondi shop', $mail->envelope()->subject);

        // One location → no location in the text.
        $this->inTenant($tenant, fn () => Location::query()->whereKey($shop)->update(['archived_at' => now()]));
        $mainRow = $this->inTenant($tenant, fn () => Inventory::query()->where('variant_id', $variant)->where('location_id', '<>', $shop)->value('id'));
        $this->assertArrayNotHasKey('location_name', $this->inTenant($tenant, fn () => Subject::load($store, 'inventory', $mainRow))->context);
    }
}
