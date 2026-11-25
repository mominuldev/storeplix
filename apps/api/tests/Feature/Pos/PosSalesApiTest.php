<?php

declare(strict_types=1);

namespace Tests\Feature\Pos;

use App\Domain\Billing\Models\Plan;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Customers\Models\Customer;
use App\Domain\Inventory\Models\InventoryMovement;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Orders\Models\Payment;
use App\Domain\Pos\Models\PosSale;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\StoreSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8D §5, §6 (part A): the till sale — an order delivered + paid at once (P88D-2), stock out of the register
 * location only (P88D-6, S199), server prices and coupon (S198), payment parts (P88D-9, S201), customers (P88D-10),
 * idempotency (S200), plan (S197), and the quote.
 */
#[Group('pos')]
class PosSalesApiTest extends TestCase
{
    use PosFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_cash_sale_with_change_is_a_delivered_paid_order_and_stock_leaves_the_register_location(): void
    {
        $s = $this->posShop(shopStock: 5, onlineStock: 10, price: 45000);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $session = $this->posSession($s);

        $sale = $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 2]], 90000, ['tendered_cash_amount' => 100000]))
            ->assertCreated()
            ->assertJsonPath('data.paid_by', 'cash')
            ->assertJsonPath('data.total_amount', 90000)
            ->assertJsonPath('data.tendered_cash_amount', 100000)
            ->assertJsonPath('data.change_amount', 10000)
            ->assertJsonPath('data.customer_name', null)
            ->assertJsonPath('data.items_count', 2)
            ->assertJsonPath('data.register_name', 'Register 1')
            ->assertJsonPath('data.session_id', $session)
            ->assertJsonPath('data.sms_receipt_status', 'no_phone')
            ->assertJsonPath('data.order.status', 'delivered')
            ->assertJsonPath('data.order.payment_status', 'paid')
            ->assertJsonPath('data.order.payment_method', 'pos')
            ->assertJsonPath('data.order.created_via', 'pos')
            ->assertJsonPath('data.order.channel', 'walk_in')
            ->assertJsonPath('data.order.paid_amount', 90000)
            ->assertJsonPath('data.order.due_amount', 0)
            ->assertJsonPath('data.order.customer.name', 'Walk-in customer')
            ->assertJsonPath('data.order.customer.phone', '')
            ->assertJsonPath('data.order.district', '')
            ->assertJsonPath('data.order.pos.register_name', 'Register 1')
            ->assertJsonPath('data.order.payments.0.method', 'cash')
            ->assertJsonPath('data.order.payments.0.provider', 'manual')
            ->assertJsonPath('data.order.payments.0.status', 'succeeded')
            ->assertJsonPath('data.order.payments.0.amount', 90000)
            ->assertJsonPath('data.order.payments.0.pos_session_id', $session)
            ->assertJsonPath('data.receipt.number', fn ($n) => is_string($n) && str_contains($n, '-'))
            ->assertJsonPath('data.receipt.change_amount', 10000)
            ->assertJsonPath('data.receipt.customer', null)
            ->json('data');
        $this->assertSame($sale['number'], $sale['receipt']['number']); // receipt number = order number (P88D-3)
        $this->assertSame($sale['id'], $sale['order']['pos']['sale_id']);

        // Stock: −2 at the shop only; the online location is untouched; one ledger row per stock row.
        $this->assertSame(3, $this->onHand($tenant, $v, $s['shop']));
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main']));
        $this->assertSame([['reason' => 'pos_sale', 'delta' => -2, 'location_id' => $s['shop'], 'reference_type' => 'order', 'reference_id' => $sale['order_id']]], $this->posLedger($tenant, $v));

        // Order row: lifecycle timestamps = placement time; lines at the register location with the cost snapshot.
        /** @var Order $order */
        $order = $this->platformQuery(Order::class)->whereKey($sale['order_id'])->firstOrFail();
        foreach (['confirmed_at', 'shipped_at', 'delivered_at'] as $at) {
            $this->assertTrue($order->placed_at->equalTo($order->{$at}), $at);
        }
        $this->assertSame([], $order->shipping_address);
        $this->assertSame('', $order->district_code);
        $this->assertSame('', $order->shipping_zone_name);
        $this->assertNull($order->customer_id);
        $item = $this->platformQuery(OrderItem::class)->where('order_id', $order->id)->sole();
        $this->assertSame($s['shop'], $item->location_id);
        $this->assertTrue($item->tracked);
        $this->assertSame(1, $this->platformQuery(PosSale::class)->where('order_id', $order->id)->count());

        // No order notification: no SMS, no email (P88D-13).
        $this->assertSame(0, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->count());
        Mail::assertNothingQueued();
        Mail::assertNothingSent();
    }

    public function test_bkash_card_and_split_payments_are_manual_rows_bound_to_the_session(): void
    {
        $s = $this->posShop(shopStock: 10, price: 50000);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 1]];

        $bkash = $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'bkash_personal', 'amount' => 50000, 'reference' => ' 9AB7CD12 ']], 'tendered_cash_amount' => null]))
            ->assertCreated()->assertJsonPath('data.paid_by', 'bkash_personal')->assertJsonPath('data.change_amount', 0)->assertJsonPath('data.tendered_cash_amount', null)
            ->assertJsonPath('data.order.payments.0.reference', '9AB7CD12')->json('data');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'card', 'amount' => 50000, 'reference' => 'APP-221']]]))
            ->assertCreated()->assertJsonPath('data.paid_by', 'card')->assertJsonPath('data.order.payments.0.method', 'card')
            ->assertJsonPath('data.tendered_cash_amount', null); // tendered is ignored without a cash part
        $split = $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 2]], 100000, [
            'payments' => [['method' => 'cash', 'amount' => 30000, 'reference' => 'ignored'], ['method' => 'bkash_personal', 'amount' => 70000]],
            'tendered_cash_amount' => 50000,
        ]))->assertCreated()->assertJsonPath('data.paid_by', 'split')->assertJsonPath('data.change_amount', 20000)
            ->assertJsonPath('data.receipt.payments', [['method' => 'cash', 'amount' => 30000], ['method' => 'bkash_personal', 'amount' => 70000]])
            ->json('data');
        $this->assertNull($split['order']['payments'][0]['reference']); // a cash part never stores a reference

        $rows = $this->platformQuery(Payment::class)->where('pos_session_id', $session)->get();
        $this->assertCount(4, $rows);
        foreach ($rows as $row) {
            $this->assertSame(['manual', 'charge', 'succeeded', 'order'], [$row->provider, $row->type, $row->status, $row->purpose]);
            $this->assertNotNull($row->verified_at);
            $this->assertNotNull($row->actor_user_id);
        }
        $this->assertSame(200000, (int) $rows->sum('amount')); // Σ parts = Σ totals; change is never a payment

        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk()
            ->assertJsonPath('data.totals.cash_sales_amount', 30000)
            ->assertJsonPath('data.totals.cash_in_drawer_amount', 130000)
            ->assertJsonPath('data.totals.sales_amount', 200000)
            ->assertJsonPath('data.totals.receipts_count', 3)
            ->assertJsonPath('data.totals.by_method', [
                ['method' => 'cash', 'amount' => 30000, 'count' => 1],
                ['method' => 'bkash_personal', 'amount' => 120000, 'count' => 2],
                ['method' => 'card', 'amount' => 50000, 'count' => 1],
            ]);
        $this->api($h, 'GET', $this->pUrl($store, "/sales/{$bkash['id']}"))->assertOk()->assertJsonPath('data.id', $bkash['id']);
    }

    public function test_payment_rules(): void
    {
        $s = $this->posShop(price: 50000);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 1]];

        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'cash', 'amount' => 40000]]]))
            ->assertStatus(422)->assertJsonPath('error.code', 'pos_payment_mismatch')
            ->assertJsonPath('error.details.total_amount', 50000)->assertJsonPath('error.details.paid_amount', 40000);
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['tendered_cash_amount' => 49999]))
            ->assertStatus(422)->assertJsonPath('error.code', 'cash_tendered_short');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['tendered_cash_amount' => null]))
            ->assertStatus(422)->assertJsonPath('error.code', 'cash_tendered_short');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'cash', 'amount' => 20000], ['method' => 'cash', 'amount' => 30000]]]))
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')->assertJsonValidationErrors(['payments.1.method'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => array_fill(0, 5, ['method' => 'card', 'amount' => 10000])]))
            ->assertStatus(422)->assertJsonValidationErrors(['payments'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'nagad_personal', 'amount' => 50000]]]))
            ->assertStatus(422)->assertJsonValidationErrors(['payments.0.method'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'card', 'amount' => 0], ['method' => 'card', 'amount' => 50000]]]))
            ->assertStatus(422)->assertJsonValidationErrors(['payments.0.amount'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 50000, ['payments' => [['method' => 'card', 'amount' => 50000, 'reference' => str_repeat('A', 33)]]]))
            ->assertStatus(422)->assertJsonValidationErrors(['payments.0.reference'], 'error.details');
        // Nothing was sold by any refused attempt.
        $this->assertSame(0, $this->platformQuery(Order::class)->where('tenant_id', $s['tenant']->id)->count());
        $this->assertSame(5, $this->onHand($s['tenant'], $v, $s['shop']));
    }

    public function test_prices_are_the_servers_and_a_changed_total_is_409_with_the_fresh_quote(): void
    {
        $s = $this->posShop(price: 50000);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 2]];

        $this->sell($h, $store, $this->saleBody($session, $line, 90000, ['payments' => [['method' => 'card', 'amount' => 90000]]]))
            ->assertStatus(409)->assertJsonPath('error.code', 'checkout_changed')
            ->assertJsonPath('error.details.quote.total_amount', 100000)
            ->assertJsonPath('error.details.quote.lines.0.unit_price_amount', 50000);
        // Unknown body fields like prices are ignored, never read (S198).
        $this->sell($h, $store, $this->saleBody($session, $line, 100000, ['payments' => [['method' => 'card', 'amount' => 100000]], 'unit_price_amount' => 1]))
            ->assertCreated()->assertJsonPath('data.total_amount', 100000);
    }

    public function test_coupon_at_the_till_is_validated_redeemed_and_printed(): void
    {
        $s = $this->posShop(price: 100000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'LOYAL5', 'type' => 'percentage', 'percent_bps' => 500, 'status' => 'active', 'usage_per_customer' => 1])->assertCreated();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/coupons", ['code' => 'FREESHIP', 'type' => 'free_shipping', 'status' => 'active'])->assertCreated();
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 1]];

        $this->quote($h, $store, $session, $line, ['coupon_code' => 'loyal5'])->assertOk()
            ->assertJsonPath('data.subtotal_amount', 100000)->assertJsonPath('data.discount_amount', 5000)
            ->assertJsonPath('data.coupon_code', 'LOYAL5')->assertJsonPath('data.total_amount', 95000);
        $sale = $this->sell($h, $store, $this->saleBody($session, $line, 95000, ['coupon_code' => 'LOYAL5', 'customer' => ['phone' => '01711552211', 'name' => 'Farhana Yasmin']]))
            ->assertCreated()->assertJsonPath('data.order.coupon_code', 'LOYAL5')->assertJsonPath('data.order.discount_amount', 5000)
            ->assertJsonPath('data.receipt.discount_amount', 5000)->assertJsonPath('data.receipt.coupon_code', 'LOYAL5')->json('data');
        $this->assertSame(1, (int) $this->platformQuery(Coupon::class)->where('tenant_id', $tenant->id)->where('code', 'LOYAL5')->value('used_count'));
        $this->assertSame(95000, (int) $this->platformQuery(Order::class)->whereKey($sale['order_id'])->value('total_amount'));

        // Per-customer limit enforced by phone (S198); a free-shipping code has nothing to discount at the till.
        $this->sell($h, $store, $this->saleBody($session, $line, 95000, ['coupon_code' => 'LOYAL5', 'customer' => ['phone' => '01711552211']]))
            ->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid');
        $this->quote($h, $store, $session, $line, ['coupon_code' => 'FREESHIP'])->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid');
        $this->quote($h, $store, $session, $line, ['coupon_code' => 'NOPE'])->assertStatus(422)->assertJsonPath('error.code', 'coupon_invalid');
    }

    public function test_customers_new_by_phone_existing_counters_and_by_id(): void
    {
        $s = $this->posShop(shopStock: 10, price: 70000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $session = $this->posSession($s);
        $line = [['variant_id' => $v, 'quantity' => 1]];

        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer' => ['phone' => '01711-552211']]))
            ->assertStatus(422)->assertJsonValidationErrors(['customer.name'], 'error.details');
        $first = $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer' => ['phone' => '01711-552211', 'name' => 'Farhana Yasmin']]))
            ->assertCreated()->assertJsonPath('data.customer_name', 'Farhana Yasmin')
            ->assertJsonPath('data.order.customer.phone', '8801711552211')
            ->assertJsonPath('data.order.customer.orders_count', 1)
            ->assertJsonPath('data.order.customer.delivered_orders_count', 1)
            ->assertJsonPath('data.order.customer.total_spent_amount', 70000)
            ->assertJsonPath('data.receipt.customer', ['name' => 'Farhana Yasmin', 'phone' => '01711-552211'])
            ->json('data');
        /** @var Customer $customer */
        $customer = $this->platformQuery(Customer::class)->where('tenant_id', $tenant->id)->where('phone', '8801711552211')->sole();
        $this->assertSame(['walk_in', 'manual'], [$customer->channel, $customer->source]);
        $this->assertSame($customer->id, $first['order']['customer']['id']);

        // Same phone again (another name is ignored: the customer keeps theirs), then by id.
        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer' => ['phone' => '01711552211', 'name' => 'Someone Else']]))
            ->assertCreated()->assertJsonPath('data.customer_name', 'Farhana Yasmin');
        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer_id' => $customer->id]))
            ->assertCreated()->assertJsonPath('data.order.customer.orders_count', 3)->assertJsonPath('data.order.customer.total_spent_amount', 210000);
        $customer->refresh();
        $this->assertSame([3, 3, 210000], [(int) $customer->orders_count, (int) $customer->delivered_orders_count, (int) $customer->total_spent_amount]);

        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer_id' => (string) Str::ulid()]))
            ->assertStatus(422)->assertJsonValidationErrors(['customer_id'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer_id' => $customer->id, 'customer' => ['phone' => '01711552211']]))
            ->assertStatus(422)->assertJsonValidationErrors(['customer'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, $line, 70000, ['customer' => ['phone' => '12345']]))
            ->assertStatus(422)->assertJsonValidationErrors(['customer.phone'], 'error.details');
    }

    public function test_stock_is_checked_at_the_register_location_against_available_never_below_zero(): void
    {
        $s = $this->posShop(shopStock: 3, onlineStock: 50, price: 10000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $session = $this->posSession($s);

        // The online location has plenty; the shop has 3 → the till refuses 4.
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 4]], 40000))
            ->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock')
            ->assertJsonPath('error.details', ['lines.0.quantity' => ['Only 3 left at Mirpur shop.']]);
        // Two lines of the same variant are summed.
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 2], ['variant_id' => $v, 'quantity' => 2]], 40000))
            ->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock');
        $this->cashSale($s, $session, 3);
        $this->assertSame(0, $this->onHand($tenant, $v, $s['shop']));
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 1]], 10000))
            ->assertStatus(422)->assertJsonPath('error.details', ['lines.0.quantity' => ['None left at Mirpur shop.']]);
        $this->assertSame(50, $this->onHand($tenant, $v, $s['main']));
        $this->assertSame(0, $this->onHand($tenant, $v, $s['shop']));
    }

    public function test_a_register_at_the_online_location_never_sells_stock_promised_to_an_online_order(): void
    {
        $s = $this->posShop(shopStock: 0, onlineStock: 3, price: 10000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $online = $this->addRegister($h, $store, 'Counter', $s['main'])->assertCreated()->json('data.id');
        $session = $this->openRegister($h, $store, $online)->assertCreated()->json('data.id');
        $this->placeOrder($store, $v, 2); // commits 2 of the 3 at the online location (backorder off)

        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 2]])->assertOk()
            ->assertJsonPath('data.lines.0.available', 1)->assertJsonPath('data.lines.0.problem', 'not_enough_stock');
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 2]], 20000))
            ->assertStatus(422)->assertJsonPath('error.details', ['lines.0.quantity' => ['Only 1 left at Main warehouse.']]);
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 1]], 10000))->assertCreated();
        $this->assertSame(['on_hand' => 2, 'committed' => 2], $this->row($tenant, $v, $s['main']));
    }

    public function test_untracked_variants_sell_freely_and_backorder_is_ignored_at_the_till(): void
    {
        $s = $this->posShop(shopStock: 0, price: 10000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        [, $untracked] = $this->stocked($h, $store, price: 20000, stock: 0, variant: ['track_inventory' => false]);
        [, $backorder] = $this->stocked($h, $store, price: 30000, stock: 0, variant: ['allow_backorder' => true]);
        $session = $this->posSession($s);

        $this->quote($h, $store, $session, [['variant_id' => $untracked, 'quantity' => 5]])->assertOk()
            ->assertJsonPath('data.lines.0.available', null)->assertJsonPath('data.lines.0.problem', null);
        $sale = $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $untracked, 'quantity' => 5]], 100000))->assertCreated()->json('data');
        $this->assertNull($this->platformQuery(OrderItem::class)->where('order_id', $sale['order_id'])->value('location_id'));
        $this->assertSame(0, $this->platformQuery(InventoryMovement::class)->where('tenant_id', $tenant->id)->where('reason', 'pos_sale')->count());
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $backorder, 'quantity' => 1]], 30000))
            ->assertStatus(422)->assertJsonPath('error.code', 'out_of_stock');
    }

    public function test_line_validation_and_foreign_ids(): void
    {
        $s = $this->posShop(price: 10000);
        [$h, $store] = [$s['h'], $s['store']];
        $other = $this->posShop(slug: 'other');
        $draft = $this->createProduct($h, $store, $this->simpleProduct('Draft tee', 10000, ['status' => 'draft'], ['initial_on_hand' => 5]))['variants'][0]['id'];
        $session = $this->posSession($s);
        $otherSession = $this->posSession($other);

        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $other['variant'], 'quantity' => 1]], 10000))
            ->assertStatus(422)->assertJsonPath('error.details', ['lines.0.variant_id' => ['Unknown variant.']]);
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $draft, 'quantity' => 1]], 10000))
            ->assertStatus(422)->assertJsonValidationErrors(['lines.0.variant_id'], 'error.details');
        $this->sell($h, $store, $this->saleBody($otherSession, [['variant_id' => $s['variant'], 'quantity' => 1]], 10000))
            ->assertStatus(422)->assertJsonValidationErrors(['session_id'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, [], 0))->assertStatus(422)->assertJsonValidationErrors(['lines'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, array_fill(0, 51, ['variant_id' => $s['variant'], 'quantity' => 1]), 510000))
            ->assertStatus(422)->assertJsonValidationErrors(['lines'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1000]], 0))
            ->assertStatus(422)->assertJsonValidationErrors(['lines.0.quantity'], 'error.details');
        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $s['variant'], 'quantity' => 1]], 10000, ['held_sale_id' => (string) Str::ulid()]))
            ->assertStatus(422)->assertJsonValidationErrors(['held_sale_id'], 'error.details');
        $this->sell($h, $store, ['session_id' => $session])->assertStatus(422)
            ->assertJsonValidationErrors(['lines', 'expected_total_amount', 'payments', 'sms_receipt'], 'error.details');
        // The quote reports unavailable lines instead of refusing them.
        $this->quote($h, $store, $session, [['variant_id' => $draft, 'quantity' => 1], ['variant_id' => $s['variant'], 'quantity' => 1]])->assertOk()
            ->assertJsonPath('data.lines.0.problem', 'unavailable')->assertJsonPath('data.lines.0.line_total_amount', 0)
            ->assertJsonPath('data.items_count', 1)->assertJsonPath('data.total_amount', 10000);
        $this->quote($h, $store, $session, [['variant_id' => $other['variant'], 'quantity' => 1]])->assertStatus(422);
        $this->quote($h, $store, $otherSession, [['variant_id' => $s['variant'], 'quantity' => 1]])->assertStatus(422)->assertJsonValidationErrors(['session_id'], 'error.details');
    }

    public function test_quote_lines_availability_and_included_vat(): void
    {
        $s = $this->posShop(shopStock: 2, price: 115000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $session = $this->posSession($s);

        $q = $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 2]])->assertOk()->json('data');
        $this->assertSame([
            'currency' => 'BDT', 'items_count' => 2, 'subtotal_amount' => 230000, 'discount_amount' => 0, 'coupon_code' => null,
            'vat' => null, 'total_amount' => 230000,
        ], array_diff_key($q, ['lines' => 1]));
        $this->assertSame(['variant_id' => $v, 'quantity' => 2, 'unit_price_amount' => 115000, 'compare_at_amount' => null,
            'line_total_amount' => 230000, 'available' => 2, 'problem' => null], array_diff_key($q['lines'][0], ['name' => 1, 'variant_title' => 1]));
        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 3]])->assertOk()->assertJsonPath('data.lines.0.problem', 'not_enough_stock');

        $this->inTenant($tenant, fn () => StoreSetting::query()->where('store_id', $store->id)
            ->update(['tax_display' => 'included', 'tax_rate_bps' => 1500, 'tax_bin' => '000123456-0101']));
        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 1]])->assertOk()
            ->assertJsonPath('data.vat', ['rate_bps' => 1500, 'amount' => 15000]); // floor(115000 × 1500 / 11500)
        $this->cashSale($s, $session, 2);
        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 1]])->assertOk()->assertJsonPath('data.lines.0.problem', 'out_of_stock');
    }

    #[Group('security')]
    public function test_idempotent_sale_replays_one_order_and_a_different_body_is_refused(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $session = $this->posSession($s);
        $body = $this->saleBody($session, [['variant_id' => $v, 'quantity' => 2]], 20000);
        $key = (string) Str::uuid();

        $first = $this->sell($h, $store, $body, $key)->assertCreated()->json('data');
        $this->sell($h, $store, $body, $key)->assertCreated()->assertHeader('Idempotent-Replayed', 'true')
            ->assertJsonPath('data.id', $first['id'])->assertJsonPath('data.order_id', $first['order_id']);
        $this->sell($h, $store, ['expected_total_amount' => 30000] + $body, $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->api($h, 'POST', $this->pUrl($store, '/sales'), $body)->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $this->assertSame(1, $this->platformQuery(Order::class)->where('tenant_id', $tenant->id)->count());
        $this->assertCount(1, $this->posLedger($tenant, $v));
        $this->assertSame(1, $this->platformQuery(Payment::class)->where('pos_session_id', $session)->count());
        $this->assertSame(3, $this->onHand($tenant, $v, $s['shop']));
    }

    public function test_a_closed_register_refuses_sales_and_quotes(): void
    {
        $s = $this->posShop(price: 10000);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $session = $this->posSession($s, 0);
        $this->closeRegister($h, $store, $session, ['counted_cash_amount' => 0, 'left_in_drawer_amount' => 0, 'revision' => 1])->assertOk();

        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 1]], 10000))
            ->assertStatus(409)->assertJsonPath('error.code', 'register_closed');
        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 1]])->assertStatus(409)->assertJsonPath('error.code', 'register_closed');
    }

    public function test_plan_without_pos_refuses_quote_and_sale_with_402(): void
    {
        $s = $this->posShop(price: 10000);
        [$h, $store, $v, $tenant] = [$s['h'], $s['store'], $s['variant'], $s['tenant']];
        $session = $this->posSession($s);
        $sale = $this->cashSale($s, $session);
        $this->planFor($tenant, Plan::STARTER);

        $this->sell($h, $store, $this->saleBody($session, [['variant_id' => $v, 'quantity' => 1]], 10000))
            ->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->quote($h, $store, $session, [['variant_id' => $v, 'quantity' => 1]])->assertStatus(402);
        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$sale['id']}/sms-receipt"))->assertStatus(402);
        // Reads stay (S197).
        $this->api($h, 'GET', $this->pUrl($store, "/sales/{$sale['id']}"))->assertOk();
        $this->api($h, 'GET', $this->pUrl($store, "/sessions/{$session}"))->assertOk();
        $this->api($h, 'GET', $this->pUrl($store, "/catalog?register_id={$s['register']}"))->assertOk();
    }

    public function test_sale_detail_carries_the_receipt_from_the_template_and_tax_settings(): void
    {
        $s = $this->posShop(price: 115000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $this->inTenant($tenant, fn () => StoreSetting::query()->where('store_id', $store->id)
            ->update(['tax_display' => 'included', 'tax_rate_bps' => 1500, 'tax_bin' => '000123456-0101']));
        $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/document-templates/receipt_80mm", ['config' => [
            'show_logo' => false, 'show_bin' => true, 'show_product_names' => true, 'show_prices' => true, 'show_sku' => true,
            'language' => 'bn', 'footer_text' => 'Thanks! Exchange within 7 days.',
        ]])->assertOk();
        $this->api($h, 'PATCH', $this->lUrl($store, "/locations/{$s['shop']}"), ['address' => 'Road 2, Mirpur 10'])->assertOk();
        $session = $this->posSession($s);
        $sale = $this->cashSale($s, $session, 1, ['tendered_cash_amount' => 120000]);

        $receipt = $this->api($h, 'GET', $this->pUrl($store, "/sales/{$sale['id']}"))->assertOk()->json('data.receipt');
        $this->assertSame('bn', $receipt['language']);
        $this->assertSame(['name' => $store->name, 'address' => 'Road 2, Mirpur 10', 'phone' => '01700-000001', 'bin' => '000123456-0101', 'logo_url' => null], $receipt['shop']);
        $this->assertSame(['rate_bps' => 1500, 'amount' => 15000], $receipt['vat']);
        $this->assertSame('Thanks! Exchange within 7 days.', $receipt['footer_text']);
        $this->assertSame(120000, $receipt['tendered_cash_amount']);
        $this->assertSame(5000, $receipt['change_amount']);
        $this->assertSame('Register 1', $receipt['register_name']);
        $this->assertNotSame('', $receipt['cashier_name']);
        $this->assertSame(1, $receipt['lines'][0]['quantity']);
        $this->assertNotNull($receipt['lines'][0]['sku']);
        $this->assertSame(115000, $receipt['total_amount']);
    }

    public function test_sms_receipt_is_sent_to_the_sales_phone_counted_and_resendable(): void
    {
        $s = $this->posShop(shopStock: 5, price: 10000);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $session = $this->posSession($s);

        $sale = $this->cashSale($s, $session, 1, ['sms_receipt' => true, 'customer' => ['phone' => '01711552211', 'name' => 'Farhana']]);
        $this->assertContains($sale['sms_receipt_status'], ['queued', 'sent']);
        $sent = app(SmsGateway::class)->sent;
        $this->assertCount(1, $sent);
        $this->assertSame('8801711552211', $sent[0]['to'] ?? $sent[0][0] ?? null);
        $text = (string) ($sent[0]['text'] ?? $sent[0][1] ?? '');
        $this->assertStringContainsString($sale['number'], $text);
        $this->assertStringNotContainsString('http', $text);
        $message = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->sole();
        $this->assertSame(['pos_receipt', '8801711552211', 'sent'], [$message->purpose, $message->to, $message->status]);
        $this->api($h, 'GET', $this->pUrl($store, "/sales/{$sale['id']}"))->assertOk()->assertJsonPath('data.sms_receipt_status', 'sent');

        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$sale['id']}/sms-receipt"))->assertOk()->assertJsonPath('data.sms_receipt_status', 'sent');
        $this->assertSame(2, $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'pos_receipt')->count());

        // Walk-in: the tick sends nothing; resend → 422 no_phone.
        $walkIn = $this->cashSale($s, $session, 1, ['sms_receipt' => true]);
        $this->assertSame('no_phone', $walkIn['sms_receipt_status']);
        $this->api($h, 'POST', $this->pUrl($store, "/sales/{$walkIn['id']}/sms-receipt"))->assertStatus(422)->assertJsonPath('error.code', 'no_phone');
        // Not ticked → not_requested.
        $plain = $this->cashSale($s, $session, 1, ['customer' => ['phone' => '01811223344', 'name' => 'Rafi']]);
        $this->assertSame('not_requested', $plain['sms_receipt_status']);
        $this->assertCount(2, app(SmsGateway::class)->sent);
    }
}
