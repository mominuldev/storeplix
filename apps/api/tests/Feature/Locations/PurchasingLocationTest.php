<?php

declare(strict_types=1);

namespace Tests\Feature\Locations;

use App\Domain\Billing\Models\Plan;
use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Inventory\Models\Location;
use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Purchasing\Models\PurchaseReceiptItem;
use App\Domain\Purchasing\PurchaseOrderPdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Purchasing\PurchasingFixtures;
use Tests\TestCase;

/** PHASE-8-8C §6, P88C-8, S186: "Receive at", receipts stock at the PO's location, weighted average over total stock. */
#[Group('locations')]
class PurchasingLocationTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPurchasing();
    }

    private function location(array $h, $store, string $name): string
    {
        return $this->api($h, 'POST', $this->pUrl($store, '/locations'), ['name' => $name, 'type' => 'shop'])->assertCreated()->json('data.id');
    }

    /** S186: stock at two locations; the receipt's cost average uses the total on hand; past order snapshots unchanged. */
    public function test_weighted_average_uses_total_on_hand_and_stock_lands_at_the_po_location(): void
    {
        [, $tenant, $store, $h] = $this->buyer('shop', Plan::GROWTH);
        $variant = $this->variant($h, $store, stock: 10, cost: 10000);
        $shop = $this->location($h, $store, 'Dhanmondi shop');
        $this->api($h, 'POST', $this->pUrl($store, '/inventory/adjustments'), ['reason' => 'received', 'items' => [
            ['variant_id' => $variant, 'mode' => 'delta', 'quantity' => 10, 'location_id' => $shop],
        ]])->assertOk();
        $order = $this->manual($h, $store, $this->manualBody($variant, 1))->assertCreated()->json('data');
        $supplier = $this->addSupplier($h, $store);

        // 20 on hand in total at 100.00; receive 20 at 200.00 at the shop → (20×10000 + 20×20000) / 40 = 15000.
        $po = $this->ordered($h, $store, $supplier['id'], [[$variant, 20000, 25]], ['location_id' => $shop]); // partly received below, so it stays editable
        $this->assertSame(['id' => $shop, 'name' => 'Dhanmondi shop'], $po['location']);
        $res = $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 20]])->assertCreated();
        $res->assertJsonPath('data.receipts.0.location', ['id' => $shop, 'name' => 'Dhanmondi shop'])
            ->assertJsonPath('data.lines.0.in_stock', 40);
        $this->assertSame(15000, $this->costOf($tenant, $variant));
        $this->assertSame(20, $this->platformQuery(PurchaseReceiptItem::class)->where('tenant_id', $tenant->id)->value('on_hand_before'));

        $this->inTenant($tenant, function () use ($variant, $shop) {
            $this->assertSame(30, Inventory::query()->where('variant_id', $variant)->where('location_id', $shop)->value('on_hand'));
            $this->assertSame(10, Inventory::query()->where('variant_id', $variant)->where('location_id', '<>', $shop)->value('on_hand'));
            $this->assertSame($shop, InventoryMovement::query()->where('reference_type', 'purchase_order')->value('location_id'));
        });
        // The order placed before keeps its cost snapshot.
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders/{$order['id']}")->assertOk()->assertJsonPath('data.items.0.unit_cost_amount', 10000);

        // Location is locked once something was received.
        $main = $this->inTenant($tenant, fn () => Location::query()->where('is_default', true)->value('id'));
        $fresh = $this->getPo($h, $store, $po['id'])->json('data');
        $this->api($h, 'PATCH', $this->pUrl($store, "/purchase-orders/{$po['id']}"), ['revision' => $fresh['revision'], 'location_id' => $main])
            ->assertUnprocessable()->assertJsonPath('error.code', 'location_locked');
    }

    public function test_default_location_and_editing_receive_at_on_a_draft(): void
    {
        [, $tenant, $store, $h] = $this->buyer('shop', Plan::GROWTH);
        $variant = $this->variant($h, $store, stock: 0);
        $supplier = $this->addSupplier($h, $store);
        $main = $this->inTenant($tenant, fn () => Location::query()->where('is_default', true)->value('id'));

        $draft = $this->draft($h, $store, $supplier['id'], [[$variant, 100, 2]]);
        $this->assertSame(['id' => $main, 'name' => 'Main warehouse'], $draft['location']);
        $shop = $this->location($h, $store, 'Hub');
        $this->api($h, 'PATCH', $this->pUrl($store, "/purchase-orders/{$draft['id']}"), ['revision' => $draft['revision'], 'location_id' => $shop])->assertOk()
            ->assertJsonPath('data.location.id', $shop);
        $this->api($h, 'GET', $this->pUrl($store, '/purchase-orders'))->assertOk()->assertJsonPath('data.0.location', ['id' => $shop, 'name' => 'Hub']);

        // Quick purchase without a location stocks the default; with one, that location.
        $this->quick($h, $store, ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $variant, 'unit_cost_amount' => 100, 'quantity' => 3]]])->assertCreated()
            ->assertJsonPath('data.location.id', $main);
        $this->quick($h, $store, ['supplier_id' => $supplier['id'], 'location_id' => $shop, 'lines' => [['variant_id' => $variant, 'unit_cost_amount' => 100, 'quantity' => 2]]])->assertCreated()
            ->assertJsonPath('data.receipts.0.location.id', $shop);
        $this->inTenant($tenant, function () use ($variant, $main, $shop) {
            $this->assertSame(3, Inventory::query()->where('variant_id', $variant)->where('location_id', $main)->value('on_hand'));
            $this->assertSame(2, Inventory::query()->where('variant_id', $variant)->where('location_id', $shop)->value('on_hand'));
        });

        // PDF names the location only when the store has > 1 active location.
        $html = $this->inTenant($tenant, fn () => app(PurchaseOrderPdf::class)->html($store, PurchaseOrder::query()->findOrFail($draft['id'])));
        $this->assertStringContainsString('Receive at Hub', $html);
    }
}
