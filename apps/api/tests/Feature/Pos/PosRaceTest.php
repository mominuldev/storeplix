<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Inventory\Models\Inventory;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Pos\Models\PosHeldSale;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Pos\Models\PosSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-8-8D S199 / S200 / S201 (Postgres races): till sales and checkouts never take a location below what orders
 * hold; one open session per register; a sale racing the close is either counted in it or refused, never lost; a
 * double-tapped sale makes one order.
 */
#[Group('pos')]
#[Group('race')]
class PosRaceTest extends TestCase
{
    use ForksRaces, PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_parallel_till_sales_and_checkouts_on_one_location_never_oversell(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop(shopStock: 0, onlineStock: 5, price: 1000);
            $counter = $this->addRegister($s['h'], $s['store'], 'Counter', $s['main'])->json('data.id'); // at the online location
            $session = $this->openRegister($s['h'], $s['store'], $counter)->json('data.id');
            $carts = [];
            for ($i = 0; $i < 3; $i++) {
                $carts[] = $this->cartWith($s['store'], $s['variant']);
            }

            $results = $this->parallel(7, fn (int $i) => $i < 4
                ? $this->sell($s['h'], $s['store'], $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 2]], 2000))->status()
                : $this->checkout($s['store'], $carts[$i - 4], $this->checkoutBody(8000, ['contact' => ['phone' => sprintf('0171600%04d', $i)]]))->status());

            $this->assertSame([], array_values(array_filter($results, fn ($r) => ! in_array($r, [201, 422], true))), json_encode($results));
            $sold = count(array_filter(array_slice($results, 0, 4), fn ($r) => $r === 201));
            $online = count(array_filter(array_slice($results, 4), fn ($r) => $r === 201));
            $row = Inventory::withoutTenancy()->where('variant_id', $s['variant'])->where('location_id', $s['main'])->firstOrFail();
            $this->assertSame(5 - 2 * $sold, $row->on_hand, json_encode($results));
            $this->assertSame($online, $row->committed);
            $this->assertGreaterThanOrEqual($row->committed, $row->on_hand);
            $this->assertSame($sold, InventoryMovement::withoutTenancy()->where('variant_id', $s['variant'])->where('reason', 'pos_sale')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_parallel_opens_of_one_register_open_one_session(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop();
            $results = $this->parallel(4, fn (int $i) => $this->openRegister($s['h'], $s['store'], $s['register'], ['opening_cash_amount' => $i])->status());
            sort($results);
            $this->assertSame([201, 409, 409, 409], $results);
            $this->assertSame(1, PosSession::withoutTenancy()->where('register_id', $s['register'])->where('status', 'open')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_a_sale_racing_the_close_is_counted_in_it_or_refused(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop(shopStock: 20, price: 1000);
            $session = $this->posSession($s, 0);

            $results = $this->parallel(5, fn (int $i) => $i === 4
                ? $this->closeRegister($s['h'], $s['store'], $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'note' => 'race', 'revision' => 1])->status()
                : $this->sell($s['h'], $s['store'], $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1]], 1000))->status());

            $this->assertSame(200, $results[4], json_encode($results));
            $this->assertSame([], array_values(array_filter(array_slice($results, 0, 4), fn ($r) => ! in_array($r, [201, 409], true))), json_encode($results));
            $sold = count(array_filter(array_slice($results, 0, 4), fn ($r) => $r === 201));
            $closed = PosSession::withoutTenancy()->whereKey($session)->firstOrFail();
            $cash = (int) Payment::withoutTenancy()->where('pos_session_id', $session)->sum('amount');
            $this->assertSame($sold * 1000, $cash);
            $this->assertSame($cash, $closed->expected_cash_amount); // every committed sale is in the close
            $this->assertSame($sold, PosSale::withoutTenancy()->where('session_id', $session)->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_a_double_tapped_sale_makes_one_order(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop(shopStock: 5, price: 1000);
            $session = $this->posSession($s);
            $key = (string) Str::uuid();
            $body = $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1]], 1000);

            $results = $this->parallel(4, fn (int $i) => $this->sell($s['h'], $s['store'], $body, $key)->status());

            $this->assertContains(201, $results);
            $this->assertSame([], array_values(array_filter($results, fn ($r) => ! in_array($r, [201, 409], true))), json_encode($results));
            $this->assertSame(1, Order::withoutTenancy()->where('store_id', $s['store']->id)->where('created_via', 'pos')->count());
            $this->assertSame(4, (int) Inventory::withoutTenancy()->where('variant_id', $s['variant'])->where('location_id', $s['shop'])->value('on_hand'));
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_two_resumes_of_one_held_sale_complete_it_once(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop(shopStock: 10, price: 1000);
            $session = $this->posSession($s);
            $held = $this->api($s['h'], 'POST', $this->pUrl($s['store'], '/held-sales'), ['session_id' => $session, 'lines' => [['variant_id' => $s['variant'], 'quantity' => 1]]])->json('data.id');
            $body = $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1]], 1000, ['held_sale_id' => $held]);

            $results = $this->parallel(3, fn (int $i) => $this->sell($s['h'], $s['store'], $body)->status());

            sort($results);
            $this->assertSame([201, 422, 422], $results);
            $this->assertSame(1, PosSale::withoutTenancy()->where('session_id', $session)->count());
            $this->assertSame(0, PosHeldSale::withoutTenancy()->whereKey($held)->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_a_cash_return_racing_the_close_is_counted_in_it_or_refused_and_two_never_empty_the_drawer_twice(): void
    {
        $this->requirePostgresRace();
        try {
            $s = $this->posShop(shopStock: 10, price: 1000);
            $session = $this->posSession($s, 0);
            $sales = [];
            for ($i = 0; $i < 3; $i++) {
                $sales[] = $this->cashSale($s, $session); // drawer: 3000
            }
            $card = $this->cashSale($s, $session, 1, ['payments' => [['method' => 'card', 'amount' => 1000]], 'tendered_cash_amount' => null]);
            $ret = fn (array $sale, string $method) => $this->api($s['h'] + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->pUrl($s['store'], "/sales/{$sale['id']}/returns"),
                ['session_id' => $session, 'lines' => [['order_item_id' => $sale['order']['items'][0]['id'], 'quantity' => 1]], 'refund_method' => $method])->status();

            // Two returns of the same line: one wins (S206).
            $same = $this->parallel(2, fn (int $i) => $ret($card, 'card'));
            sort($same);
            $this->assertSame([201, 409], $same, json_encode($same));

            $results = $this->parallel(4, fn (int $i) => $i === 3
                ? $this->closeRegister($s['h'], $s['store'], $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'note' => 'race', 'revision' => 1])->status()
                : $ret($sales[$i], 'cash'));

            $this->assertSame(200, $results[3], json_encode($results));
            $this->assertSame([], array_values(array_filter(array_slice($results, 0, 3), fn ($r) => ! in_array($r, [201, 409], true))), json_encode($results));
            $refunded = count(array_filter(array_slice($results, 0, 3), fn ($r) => $r === 201));
            $closed = PosSession::withoutTenancy()->whereKey($session)->firstOrFail();
            $this->assertSame(3000 - 1000 * $refunded, $closed->expected_cash_amount); // every committed refund is in the close
            $this->assertSame($refunded, Payment::withoutTenancy()->where('pos_session_id', $session)->where('type', 'refund')->where('method', 'cash')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
