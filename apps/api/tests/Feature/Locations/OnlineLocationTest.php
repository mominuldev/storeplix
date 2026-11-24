<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8C P88C-4/5/16: storefront, carts and checkout sell from the online (default) location only (S183); order
 * lines remember their location, so cancel / ship / return / edits after the online location changes hit the original
 * row (S184).
 */
#[Group('locations')]
class OnlineLocationTest extends TestCase
{
    use LocationFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    /** S183: availability, in-stock filter, cart and checkout never see stock at a non-online location. */
    public function test_storefront_and_checkout_use_only_the_online_location(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        [$product, $variant] = $this->stocked($h, $store, stock: 3);
        [$other, $otherVariant] = $this->stocked($h, $store, stock: 0);
        $shop = $this->addLocation($h, $store);
        $this->adjustAt($h, $store, [
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 10, 'location_id' => $shop['id']],
            ['variant_id' => $otherVariant, 'mode' => 'delta', 'quantity' => 5, 'location_id' => $shop['id']],
        ])->assertOk();

        $this->sf($store, 'GET', "/products/{$product['slug']}/availability")->assertOk()
            ->assertJsonPath('data.variants.0.available', true)->assertJsonPath('data.variants.0.low_stock', 3);
        $this->sf($store, 'GET', "/products/{$other['slug']}/availability")->assertOk()->assertJsonPath('data.variants.0.available', false);
        $inStock = array_column($this->sf($store, 'GET', '/products?in_stock=1')->assertOk()->json('data'), 'slug');
        $this->assertContains($product['slug'], $inStock);
        $this->assertNotContains($other['slug'], $inStock);

        $this->sf($store, 'POST', '/cart/items', ['variant_id' => $variant, 'quantity' => 4])->assertUnprocessable()->assertJsonPath('error.code', 'out_of_stock');
        $this->manual($h, $store, $this->manualBody($variant, 4))->assertUnprocessable()->assertJsonPath('error.code', 'out_of_stock');
        $this->placeOrder($store, $variant, 3);
        $main = $this->defaultLocation($tenant, $store);
        $this->assertSame(['on_hand' => 3, 'committed' => 3], $this->row($tenant, $variant, $main->id));
        $this->assertSame(['on_hand' => 10, 'committed' => 0], $this->row($tenant, $variant, $shop['id']));
        $this->assertSame([$main->id], $this->lineLocations($tenant));

        // P88C-5: switching the online location switches the storefront at once.
        $this->makeDefault($h, $store, $shop['id'])->assertOk();
        $this->sf($store, 'GET', "/products/{$product['slug']}/availability")->assertOk()
            ->assertJsonPath('data.variants.0.available', true)->assertJsonPath('data.variants.0.low_stock', null);
        $this->assertContains($other['slug'], array_column($this->sf($store, 'GET', '/products?in_stock=1')->json('data'), 'slug'));
        $this->placeOrder($store, $otherVariant, 2);
        $this->assertSame(['on_hand' => 5, 'committed' => 2], $this->row($tenant, $otherVariant, $shop['id']));
    }

    /** S184: cancel, ship, return and edits after the online location changed use each line's stored location. */
    public function test_stored_location_matrix_after_switching(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $main = $this->defaultLocation($tenant, $store);
        [, $variant] = $this->stocked($h, $store, stock: 10);
        $shop = $this->addLocation($h, $store);

        $toCancel = $this->manual($h, $store, $this->manualBody($variant, 2))->assertCreated()->json('data');
        $toShip = $this->manual($h, $store, $this->manualBody($variant, 3))->assertCreated()->json('data');
        $toEdit = $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated()->json('data');
        $this->assertSame(['on_hand' => 10, 'committed' => 6], $this->row($tenant, $variant, $main->id));

        $this->makeDefault($h, $store, $shop['id'])->assertOk();
        $this->adjustAt($h, $store, [['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 4, 'location_id' => $shop['id']]])->assertOk();
        $orders = "/api/v1/stores/{$store->id}/orders";

        // Cancel → released at main; nothing appears at the shop.
        $this->api($h, 'POST', "{$orders}/{$toCancel['id']}/cancel", ['reason' => 'unreachable', 'notify_customer' => false])->assertOk();
        $this->assertSame(['on_hand' => 10, 'committed' => 4], $this->row($tenant, $variant, $main->id));
        $this->assertSame(['on_hand' => 4, 'committed' => 0], $this->row($tenant, $variant, $shop['id']));

        // Edit: the kept line grows at its stored location (main), a new line commits at the new online location.
        $item = $toEdit['items'][0];
        $this->api($h, 'PUT', "{$orders}/{$toEdit['id']}/items", ['revision' => $toEdit['revision'], 'reason' => 'customer_request', 'notify_customer' => false,
            'items' => [['id' => $item['id'], 'quantity' => 2]]])->assertOk();
        $this->assertSame(['on_hand' => 10, 'committed' => 5], $this->row($tenant, $variant, $main->id));
        $this->assertSame(['on_hand' => 4, 'committed' => 0], $this->row($tenant, $variant, $shop['id']));

        // Ship → leaves main; return → back to main.
        foreach (['confirm', 'ship'] as $step) {
            $this->api($h, 'POST', "{$orders}/{$toShip['id']}/{$step}")->assertOk();
        }
        $this->assertSame(['on_hand' => 7, 'committed' => 2], $this->row($tenant, $variant, $main->id));
        $this->api($h, 'POST', "{$orders}/{$toShip['id']}/return", ['restock' => [['item_id' => $toShip['items'][0]['id'], 'quantity' => 3]]])->assertOk();
        $this->assertSame(['on_hand' => 10, 'committed' => 2], $this->row($tenant, $variant, $main->id));
        $this->assertSame(['on_hand' => 4, 'committed' => 0], $this->row($tenant, $variant, $shop['id']));

        $this->inTenant($tenant, function () use ($main) {
            $this->assertSame(['order_returned', 'order_shipped'], InventoryMovement::query()->whereIn('reason', ['order_shipped', 'order_returned'])
                ->where('location_id', $main->id)->orderBy('reason')->pluck('reason')->all());
        });

        // A new order now commits at the shop and remembers it.
        $new = $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated()->json('data');
        $this->assertSame(['on_hand' => 4, 'committed' => 1], $this->row($tenant, $variant, $shop['id']));
        $this->assertSame($shop['id'], $this->inTenant($tenant, fn () => OrderItem::query()->where('order_id', $new['id'])->value('location_id')));
        // An untracked line stores no location.
        [, $untracked] = $this->stocked($h, $store, stock: 0, variant: ['track_inventory' => false]);
        $u = $this->manual($h, $store, $this->manualBody($untracked, 1))->assertCreated()->json('data');
        $this->assertNull($this->inTenant($tenant, fn () => OrderItem::query()->where('order_id', $u['id'])->value('location_id')));
    }

    /** @return list<string> */
    private function lineLocations(Tenant $tenant): array
    {
        return $this->inTenant($tenant, fn () => OrderItem::query()->pluck('location_id')->unique()->values()->all());
    }
}
