<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** S170 on Postgres (fork-based): concurrent receipts on one PO never exceed what was ordered (PO row lock). */
#[Group('purchasing')]
#[Group('security')]
class PurchasingRaceTest extends TestCase
{
    use ForksRaces, PurchasingFixtures, RefreshDatabase;

    #[Group('race')]
    public function test_concurrent_receipts_never_exceed_ordered(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpPurchasing();
            [, $tenant, $store, $h] = $this->buyer();
            $variant = $this->variant($h, $store, stock: 0, cost: 1000);
            $supplier = $this->addSupplier($h, $store);
            $po = $this->ordered($h, $store, $supplier['id'], [[$variant, 1000, 5]]);
            $item = $po['lines'][0]['id'];

            // 8 receipts of 2 units at once (each with its own key) against 5 left: exactly two succeed.
            $results = $this->parallel(8, fn (int $i) => $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 2]], [], 'race-'.$i.'-'.Str::random(8))->status());
            sort($results);
            $this->assertSame([201, 201, 422, 422, 422, 422, 422, 422], $results);

            $this->assertSame(4, $this->onHand($tenant, $variant));
            $this->assertSame(4, (int) $this->platformTable('purchase_order_items')->where('id', $item)->value('quantity_received'));
            $this->assertSame(2, $this->platformTable('purchase_receipts')->where('purchase_order_id', $po['id'])->count());
            $this->assertSame(2, $this->platformTable('inventory_movements')->where('reference_id', $po['id'])->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
