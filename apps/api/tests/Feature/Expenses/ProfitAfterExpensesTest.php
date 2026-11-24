<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Billing\Models\Plan;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-7 §7 (amends PHASE-7 §6.4), S150: expenses by `spent_on` in summary, previous, per_order, daily and weekly.
 * Every expected figure is worked out by hand from the rows below.
 */
#[Group('expenses')]
#[Group('reports')]
class ProfitAfterExpensesTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase;

    private const OCT = ['from' => '2026-10-01', 'to' => '2026-10-31'];

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpExpenses();
    }

    public function test_profit_and_loss_with_expenses(): void
    {
        [, $t, $store, $h] = $this->growthShop();
        [, $t2, $store2, $h2] = $this->growthShop('other');

        // Delivered Mon 5 Oct 16:00 Dhaka: revenue 100000, product 30000, delivery 6000, COD fee 1000.
        $o = $this->order($t, $store, ['status' => 'delivered', 'placed_at' => '2026-10-01 10:00:00', 'delivered_at' => '2026-10-05 10:00:00', 'total' => 100000]);
        $this->item($t, $store, $o, ['qty' => 1, 'total' => 100000, 'cost' => 30000]);
        $this->shipment($t, $store, $o, ['status' => 'delivered', 'delivered_at' => '2026-10-05 10:00:00', 'fee' => 6000, 'cod_charge' => 1000]);

        $this->addExpense($h, $store, ['amount' => 20000, 'category' => 'ads', 'spent_on' => '2026-10-05']);       // order day
        $this->addExpense($h, $store, ['amount' => 3000, 'category' => 'packaging', 'spent_on' => '2026-10-05']);  // order day
        $this->addExpense($h, $store, ['amount' => 50000, 'category' => 'rent_bills', 'spent_on' => '2026-10-10']); // Sat, no orders
        $this->addExpense($h, $store, ['amount' => 7000, 'category' => 'ads', 'spent_on' => '2026-11-01']);        // outside (Sun of W44)
        $this->addExpense($h, $store, ['amount' => 15000, 'category' => 'salaries', 'spent_on' => '2026-09-15']);  // previous period (W38)
        $this->addExpense($h2, $store2, ['amount' => 99999, 'category' => 'ads', 'spent_on' => '2026-10-05']);     // another store

        $r = $this->report($h, $store, 'profit', self::OCT)->assertOk();
        $this->assertSame([
            'revenue_amount' => 100000, 'delivered_orders_count' => 1, 'product_cost_amount' => 30000,
            'delivery_cost_amount' => 6000, 'cod_fee_amount' => 1000, 'gateway_fee_amount' => null, 'ad_spend_amount' => 20000,
            'other_expenses_amount' => 53000, 'total_cost_amount' => 110000, 'profit_before_expenses_amount' => 63000,
            'net_profit_amount' => -10000, 'margin' => -0.1, 'profit_per_order_amount' => -10000,
        ], $r->json('data.summary'));
        $this->assertSame([
            'order_value_amount' => 100000, 'product_cost_amount' => 30000, 'delivery_cost_amount' => 6000, 'cod_fee_amount' => 1000,
            'gateway_fee_amount' => null, 'ad_spend_amount' => 20000, 'other_expenses_amount' => 53000, 'profit_amount' => -10000,
        ], $r->json('data.per_order'));
        $r->assertJsonPath('data.data_quality.expenses_count', 3);
        $this->assertSame([
            'revenue_amount' => 0, 'delivered_orders_count' => 0, 'product_cost_amount' => 0, 'delivery_cost_amount' => 0,
            'cod_fee_amount' => 0, 'gateway_fee_amount' => null, 'ad_spend_amount' => 0, 'other_expenses_amount' => 15000,
            'total_cost_amount' => 15000, 'profit_before_expenses_amount' => 0, 'net_profit_amount' => -15000, 'margin' => null,
            'profit_per_order_amount' => null,
        ], $r->json('data.previous'));

        $daily = collect($r->json('data.daily'))->keyBy('date');
        $this->assertEquals(['date' => '2026-10-05', 'orders_count' => 1, 'revenue_amount' => 100000, 'product_cost_amount' => 30000,
            'delivery_cost_amount' => 6000, 'cod_fee_amount' => 1000, 'gateway_fee_amount' => null, 'ad_spend_amount' => 20000,
            'other_expenses_amount' => 3000, 'total_cost_amount' => 60000, 'profit_before_expenses_amount' => 63000,
            'net_profit_amount' => 40000, 'margin' => 0.4], $daily['2026-10-05']);
        $this->assertEquals(['date' => '2026-10-10', 'orders_count' => 0, 'revenue_amount' => 0, 'product_cost_amount' => 0,
            'delivery_cost_amount' => 0, 'cod_fee_amount' => 0, 'gateway_fee_amount' => null, 'ad_spend_amount' => 0,
            'other_expenses_amount' => 50000, 'total_cost_amount' => 50000, 'profit_before_expenses_amount' => 0,
            'net_profit_amount' => -50000, 'margin' => null], $daily['2026-10-10']);
        $this->assertSame(0, $daily['2026-10-11']['total_cost_amount']);
        $this->assertSame(-10000, $daily->sum('net_profit_amount'));

        $weekly = collect($r->json('data.weekly'))->keyBy('week');
        $this->assertEquals(['week' => '2026-W41', 'week_start' => '2026-10-05', 'revenue_amount' => 100000, 'net_profit_amount' => -10000, 'margin' => -0.1], $weekly['2026-W41']);
        $this->assertEquals(['week' => '2026-W38', 'week_start' => '2026-09-14', 'revenue_amount' => 0, 'net_profit_amount' => -15000, 'margin' => null], $weekly['2026-W38']);
        $this->assertSame(-7000, $weekly['2026-W44']['net_profit_amount']); // Sun 1 Nov is in ISO week 44
        $this->assertSame(0, $weekly['2026-W42']['net_profit_amount']);

        // The Expenses page profit tile equals P&L net profit for the same month (AC 3).
        $this->api($h, 'GET', $this->eUrl($store, '/summary?month=2026-10'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', -10000);
        // The other store sees only its own.
        $this->report($h2, $store2, 'profit', self::OCT)->assertOk()->assertJsonPath('data.summary.ad_spend_amount', 99999)
            ->assertJsonPath('data.summary.other_expenses_amount', 0);
    }

    public function test_expenses_without_delivered_orders_keep_per_order_null(): void
    {
        [, , $store, $h] = $this->growthShop();
        $this->addExpense($h, $store, ['amount' => 5000, 'category' => 'ads', 'spent_on' => '2026-10-12']);
        $this->report($h, $store, 'profit', self::OCT)->assertOk()
            ->assertJsonPath('data.per_order', null)->assertJsonPath('data.summary.net_profit_amount', -5000)
            ->assertJsonPath('data.summary.margin', null)->assertJsonPath('data.summary.profit_per_order_amount', null);
    }

    public function test_profit_route_gates_are_unchanged(): void
    {
        [, $t, $store, $h] = $this->growthShop();
        $this->planFor($t, Plan::STARTER);
        $this->report($h, $store, 'profit', self::OCT)->assertStatus(402);
    }
}
