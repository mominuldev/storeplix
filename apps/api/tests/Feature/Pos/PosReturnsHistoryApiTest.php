<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\Models\Plan;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Payment;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8D §9 (part B): returns at the till (P88D-17, S206) — return + full restock at the line's location + refund
 * from the drawer (cash) or the original non-cash method, bound to the session; the drawer and close maths include
 * cash refunds — and the sales history with its KPIs and filters.
 */
#[Group('pos')]
class PosReturnsHistoryApiTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    private function returnItems(array $h, $store, string $sale, array $body, ?string $key = null)
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::uuid()], 'POST', $this->pUrl($store, "/sales/{$sale}/returns"), $body);
    }

    public function test_cash_return_restocks_at_the_shop_refunds_from_the_drawer_and_counts_in_the_close(): void
    {
        $s = $this->posShop(shopStock: 5, onlineStock: 10, price: 45000);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $session = $this->posSession($s, 100000);
        $sale = $this->cashSale($s, $session, 2, ['tendered_cash_amount' => 100000]); // +90000 cash
        $item = $sale['order']['items'][0]['id'];
        $this->assertSame(3, $this->onHand($tenant, $v, $s['shop']));

        $key = (string) Str::uuid();
        $body = ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'cash', 'reason' => 'wrong_size', 'note' => 'Too tight'];
        $result = $this->returnItems($h, $store, $sale['id'], $body, $key)->assertCreated()
            ->assertJsonPath('data.refund.type', 'refund')
            ->assertJsonPath('data.refund.method', 'cash')
            ->assertJsonPath('data.refund.amount', 45000)
            ->assertJsonPath('data.refund.pos_session_id', $session)
            ->assertJsonPath('data.return_request.type', 'return')
            ->assertJsonPath('data.return_request.status', 'refunded')
            ->assertJsonPath('data.return_request.reason', 'wrong_size')
            ->assertJsonPath('data.sale.refunded_amount', 45000)
            ->assertJsonPath('data.sale.order.payment_status', 'partially_refunded')
            ->json('data');
        $this->returnItems($h, $store, $sale['id'], $body, $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true')
            ->assertJsonPath('data.refund.id', $result['refund']['id']);
        $this->returnItems($h, $store, $sale['id'], ['refund_method' => 'card'] + $body, $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->assertSame(1, $this->platformQuery(Payment::class)->where('type', 'refund')->where('pos_session_id', $session)->count());

        // Restocked at the line's location (the shop), ledger order_returned; the online location untouched.
        $this->assertSame(4, $this->onHand($tenant, $v, $s['shop']));
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main']));
        $this->assertSame(1, $this->platformQuery(InventoryMovement::class)->where('variant_id', $v)->where('reason', 'order_returned')->where('location_id', $s['shop'])->count());

        // Drawer: 100000 + 90000 − 45000.
        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk()
            ->assertJsonPath('data.totals.cash_in_drawer_amount', 145000)
            ->assertJsonPath('data.totals.cash_refunds_amount', 45000)
            ->assertJsonPath('data.totals.returns_count', 1)
            ->assertJsonPath('data.totals.returns_amount', 45000);
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 145000, 'left_in_drawer_amount' => 100000, 'revision' => 1])->assertOk()
            ->assertJsonPath('data.expected_cash_amount', 145000)->assertJsonPath('data.variance_amount', 0)->assertJsonPath('data.banked_amount', 45000);

        $meta = json_decode((string) $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'order.refunded')->value('meta'), true);
        $this->assertSame($session, $meta['pos_session_id']);
    }

    public function test_non_cash_refunds_drawer_short_and_return_bounds(): void
    {
        $s = $this->posShop(shopStock: 10, price: 50000);
        [$h, $store] = [$s['h'], $s['store']];
        $session = $this->posSession($s, 0);
        $card = $this->cashSale($s, $session, 3, ['payments' => [['method' => 'card', 'amount' => 150000]], 'tendered_cash_amount' => null]);
        $item = $card['order']['items'][0]['id'];

        // The drawer holds ৳ 0: a cash refund is refused, bKash / card work and never touch the drawer.
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'cash'])
            ->assertStatus(422)->assertJsonPath('error.code', 'drawer_short');
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'card'])
            ->assertCreated()->assertJsonPath('data.refund.method', 'card');
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'bkash_personal'])
            ->assertCreated();
        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk()
            ->assertJsonPath('data.totals.cash_in_drawer_amount', 0)->assertJsonPath('data.totals.returns_count', 2)->assertJsonPath('data.totals.returns_amount', 100000);

        // Only 1 of 3 is left to return.
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 2]], 'refund_method' => 'card'])
            ->assertStatus(409)->assertJsonPath('error.code', 'return_not_allowed');
        // Validation.
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => (string) Str::ulid(), 'quantity' => 1]], 'refund_method' => 'card'])
            ->assertStatus(422)->assertJsonValidationErrors(['lines.0.order_item_id'], 'error.details');
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [], 'refund_method' => 'gateway'])
            ->assertStatus(422)->assertJsonValidationErrors(['lines', 'refund_method'], 'error.details');
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'card', 'reason' => 'meh'])
            ->assertStatus(422)->assertJsonValidationErrors(['reason'], 'error.details');
        $this->returnItems($h, $store, $card['id'], ['session_id' => (string) Str::ulid(), 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'card'])
            ->assertStatus(422)->assertJsonValidationErrors(['session_id'], 'error.details');
        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$card['id']}/returns"), ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'card'])
            ->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        // A closed session can't take a return.
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk();
        $this->returnItems($h, $store, $card['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $item, 'quantity' => 1]], 'refund_method' => 'card'])
            ->assertStatus(409)->assertJsonPath('error.code', 'register_closed');
    }

    #[Group('security')]
    public function test_returns_need_orders_refund_and_the_plan_and_stay_in_the_tenant(): void
    {
        $a = $this->posShop(slug: 'alpha', price: 1000);
        $b = $this->posShop(slug: 'beta', price: 1000);
        $aSession = $this->posSession($a);
        $sale = $this->cashSale($a, $aSession);
        $bSession = $this->posSession($b);
        $bSale = $this->cashSale($b, $bSession);
        $body = ['session_id' => $aSession, 'lines' => [['order_item_id' => $sale['order']['items'][0]['id'], 'quantity' => 1]], 'refund_method' => 'cash'];

        [, $staff] = $this->memberAs($a['tenant'], TenantUser::ROLE_STAFF); // pos.sell, no orders.refund
        $this->returnItems($staff, $a['store'], $sale['id'], $body)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $cashierRefunder = $this->memberWithRole($a['tenant'], $this->customRole($a['h'], 'Senior cashier', ['pos.sell', 'orders.view', 'orders.process', 'orders.refund']))[1];
        $refundOnly = $this->memberWithRole($a['tenant'], $this->customRole($a['h'], 'Refunder', ['orders.view', 'orders.process', 'orders.refund']))[1];
        $this->returnItems($refundOnly, $a['store'], $sale['id'], $body)->assertForbidden();

        $this->returnItems($a['h'], $a['store'], $bSale['id'], $body)->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->returnItems($a['h'], $a['store'], $sale['id'], ['session_id' => $bSession] + $body)->assertStatus(422)->assertJsonValidationErrors(['session_id'], 'error.details');
        $this->returnItems($a['h'], $a['store'], $sale['id'], ['lines' => [['order_item_id' => $bSale['order']['items'][0]['id'], 'quantity' => 1]]] + $body)
            ->assertStatus(422)->assertJsonValidationErrors(['lines.0.order_item_id'], 'error.details');

        $this->planFor($a['tenant'], Plan::STARTER);
        $this->returnItems($a['h'], $a['store'], $sale['id'], $body)->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->planFor($a['tenant'], Plan::GROWTH);
        $this->returnItems($cashierRefunder, $a['store'], $sale['id'], $body)->assertCreated();
    }

    public function test_history_lists_till_sales_with_kpis_and_filters(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-25 06:00:00', 'UTC')); // 12:00 Dhaka
        $s = $this->posShop(shopStock: 20, price: 10000);
        [$h, $store] = [$s['h'], $s['store']];
        $session = $this->posSession($s);
        $other = $this->addRegister($h, $store, 'Register 2', $s['shop'])->json('data.id');
        $otherSession = $this->openRegister($h, $store, $other)->json('data.id');

        Carbon::setTestNow(Carbon::parse('2026-11-24 08:00:00', 'UTC')); // yesterday 14:00 Dhaka
        $yesterday = $this->cashSale($s, $session, 1);
        Carbon::setTestNow(Carbon::parse('2026-11-25 06:00:00', 'UTC'));
        $cash = $this->cashSale($s, $session, 2, ['customer' => ['phone' => '01711552211', 'name' => 'Farhana Yasmin']]);
        $split = $this->cashSale($s, $session, 3, ['payments' => [['method' => 'cash', 'amount' => 10000], ['method' => 'card', 'amount' => 20000]]]);
        $card = $this->cashSale(['register' => $other] + $s, $otherSession, 1, ['payments' => [['method' => 'card', 'amount' => 10000]], 'tendered_cash_amount' => null]);
        $this->returnItems($h, $store, $cash['id'], ['session_id' => $session, 'lines' => [['order_item_id' => $cash['order']['items'][0]['id'], 'quantity' => 1]], 'refund_method' => 'cash'])->assertCreated();
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/orders")->assertOk(); // the online list is unaffected

        $today = $this->api($h, 'GET', $this->pUrl($store, '/sales'))->assertOk()->json();
        $this->assertSame([$card['id'], $split['id'], $cash['id']], array_column($today['data'], 'id'));
        $this->assertSame(['card', 'split', 'cash'], array_column($today['data'], 'paid_by'));
        $this->assertSame(['register_name' => 'Register 1', 'customer_name' => 'Farhana Yasmin', 'items_count' => 2, 'total_amount' => 20000, 'refunded_amount' => 10000],
            array_intersect_key($today['data'][2], array_flip(['register_name', 'customer_name', 'items_count', 'total_amount', 'refunded_amount'])));
        $this->assertNull($today['data'][0]['customer_name']);
        // sales = 20000 + 30000 + 10000 − 10000 refund; receipts 3; average 16667.
        $this->assertSame(['sales_amount' => 50000, 'receipts_count' => 3, 'average_sale_amount' => 16667, 'returns_count' => 1, 'returns_amount' => 10000], $today['meta']['summary']);
        $this->assertArrayHasKey('next_cursor', $today['meta']);

        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[date]=yesterday'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $yesterday['id']);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[date]=7d'))->assertOk()->assertJsonCount(4, 'data');
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[date]=custom&from=2026-11-24&to=2026-11-24'))->assertOk()->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->pUrl($store, "/sales?filter[register_id]={$other}"))->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('meta.summary.receipts_count', 1)->assertJsonPath('meta.summary.returns_count', 0);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[method]=split'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $split['id']);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[method]=cash'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $cash['id']);
        // q = exact number or phone, across every day.
        $this->api($h, 'GET', $this->pUrl($store, '/sales?q='.strtolower($yesterday['number'])))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $yesterday['id']);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?q=01711-552211'))->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $cash['id']);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?q=0171155'))->assertOk()->assertJsonCount(0, 'data');

        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[date]=custom'))->assertStatus(422)->assertJsonValidationErrors(['from', 'to'], 'error.details');
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[date]=custom&from=2026-11-25&to=2026-11-01'))->assertStatus(422)->assertJsonValidationErrors(['to'], 'error.details');
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[method]=nagad'))->assertStatus(422);
        $this->api($h, 'GET', $this->pUrl($store, '/sales?filter[register_id]='.Str::ulid()))->assertStatus(422);

        // Another tenant sees none of them.
        $b = $this->posShop(slug: 'beta');
        $this->api($b['h'], 'GET', $this->pUrl($b['store'], '/sales?filter[date]=7d'))->assertOk()->assertJsonCount(0, 'data');
        Carbon::setTestNow();
    }

    public function test_history_pages_by_cursor(): void
    {
        $s = $this->posShop(shopStock: 60, price: 1000);
        $session = $this->posSession($s);
        for ($i = 0; $i < 51; $i++) {
            $this->cashSale($s, $session);
        }
        $first = $this->api($s['h'], 'GET', $this->pUrl($s['store'], '/sales'))->assertOk()->assertJsonCount(50, 'data')
            ->assertJsonPath('meta.summary.receipts_count', 51)->json('meta');
        $this->api($s['h'], 'GET', $this->pUrl($s['store'], '/sales?cursor='.urlencode((string) $first['next_cursor'])))->assertOk()->assertJsonCount(1, 'data');
    }
}
