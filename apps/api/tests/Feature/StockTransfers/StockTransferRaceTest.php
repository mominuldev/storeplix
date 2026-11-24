<?php

declare(strict_types=1);

namespace Tests\Feature\StockTransfers;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Inventory\Models\StockCount;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Orders\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-8-8C S188 / S190 (Postgres races): sends and checkouts never take the source below what orders hold; one
 * transfer moves stock once; cancel and receive can't both happen; one open count per location.
 */
#[Group('stocktransfer')]
#[Group('race')]
class StockTransferRaceTest extends TestCase
{
    use ForksRaces, RefreshDatabase, StockTransferFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_parallel_sends_and_checkouts_never_take_the_source_below_committed(): void
    {
        $this->requirePostgresRace();
        try {
            [, $tenant, $store, $h] = $this->growthShop();
            [, $variant] = $this->stocked($h, $store, 1000, 5);
            $main = $this->defaultLocation($tenant, $store)->id; // the online location: checkout commits here
            $shop = $this->addLocation($h, $store)['id'];
            $transfers = [];
            for ($i = 0; $i < 3; $i++) {
                $transfers[] = $this->createTransfer($h, $store, $main, $shop, [['variant_id' => $variant, 'quantity' => 2]])->assertCreated()->json('data.id');
            }
            $carts = [];
            for ($i = 0; $i < 4; $i++) {
                $carts[] = $this->cartWith($store, $variant);
            }

            $results = $this->parallel(7, fn (int $i) => $i < 3
                ? $this->sendTransfer($h, $store, $transfers[$i])->status()
                : $this->checkout($store, $carts[$i - 3], $this->checkoutBody(8000, ['contact' => ['phone' => sprintf('0171600%04d', $i)]]))->status());

            $sent = count(array_filter(array_slice($results, 0, 3), fn ($s) => $s === 200));
            $orders = count(array_filter(array_slice($results, 3), fn ($s) => $s === 201));
            $this->assertSame([], array_values(array_filter($results, fn ($s) => ! in_array($s, [200, 201, 422], true))), json_encode($results));
            $row = Inventory::withoutTenancy()->where('variant_id', $variant)->where('location_id', $main)->firstOrFail();
            $this->assertSame(5 - 2 * $sent, $row->on_hand, json_encode($results));
            $this->assertSame($orders, $row->committed);
            $this->assertSame($orders, Order::withoutTenancy()->where('store_id', $store->id)->count());
            $this->assertGreaterThanOrEqual($row->committed, $row->on_hand, json_encode($results));
            $this->assertLessThanOrEqual(5, 2 * $sent + $orders);
            $this->assertSame($sent, InventoryMovement::withoutTenancy()->where('variant_id', $variant)->where('reason', 'transfer_out')->count());
            $this->assertSame($sent, StockTransfer::withoutTenancy()->where('store_id', $store->id)->where('status', 'in_transit')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_parallel_sends_of_one_transfer_move_stock_once(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->transferShop(10);
            $id = $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 4]])->json('data.id');

            $results = $this->parallel(4, fn (int $i) => $this->sendTransfer($s['h'], $s['store'], $id, (string) Str::uuid())->status());

            sort($results);
            $this->assertSame([200, 409, 409, 409], $results);
            $this->assertSame(6, Inventory::withoutTenancy()->where('variant_id', $s['variant'])->where('location_id', $s['main'])->value('on_hand'));
            $this->assertSame(1, InventoryMovement::withoutTenancy()->where('variant_id', $s['variant'])->where('reason', 'transfer_out')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_parallel_receive_and_cancel_settle_an_in_transit_transfer_once(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->transferShop(10);
            $t = $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 4]], ['send' => true])->json('data');

            $results = $this->parallel(4, fn (int $i) => $i % 2 === 0
                ? $this->receiveTransfer($s['h'], $s['store'], $t['id'], [['item_id' => $t['lines'][0]['id'], 'received' => 4]])->status()
                : $this->api($s['h'], 'POST', $this->lUrl($s['store'], "/stock-transfers/{$t['id']}/cancel"))->status());

            $this->assertSame(1, count(array_filter($results, fn ($r) => $r === 200)), json_encode($results));
            $main = Inventory::withoutTenancy()->where('variant_id', $s['variant'])->where('location_id', $s['main'])->value('on_hand');
            $shop = (int) Inventory::withoutTenancy()->where('variant_id', $s['variant'])->where('location_id', $s['shop'])->value('on_hand');
            $this->assertSame(10, $main + $shop); // 4 units land exactly once: at the shop OR back at the source
            $this->assertSame(1, InventoryMovement::withoutTenancy()->where('variant_id', $s['variant'])->where('reason', 'transfer_in')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_parallel_count_starts_open_one_count_per_location(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->transferShop(10);

            $results = $this->parallel(4, fn (int $i) => $this->startCount($s['h'], $s['store'], $s['main'])->status());

            sort($results);
            $this->assertSame([201, 409, 409, 409], $results);
            $this->assertSame(1, StockCount::withoutTenancy()->where('store_id', $s['store']->id)->where('status', 'in_progress')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
