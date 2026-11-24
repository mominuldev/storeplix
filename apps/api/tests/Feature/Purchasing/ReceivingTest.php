<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use App\Domain\Billing\Models\Plan;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-8B §5.3–§5.4: receipts through InventoryService (S170, S171), weighted-average landed cost (S172), past
 * Profit & loss unchanged, adjust-only receivers (S168), no expenses (S175).
 */
#[Group('purchasing')]
class ReceivingTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPurchasing();
    }

    #[Group('security')]
    public function test_partial_receipt_with_damaged_pieces_then_the_rest(): void
    {
        [$owner, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, stock: 10, cost: 1000);
        $b = $this->variant($h, $store, stock: 0);
        $supplier = $this->addSupplier($h, $store, ['name' => 'Rahman Fabrics', 'payment_terms_days' => 30]);
        // subtotal 12 000 + 10 000; transport 2 200 → shares 1 200 / 1 000 → landed A 1 320, B 550.
        $po = $this->ordered($h, $store, $supplier['id'], [[$a, 1200, 10], [$b, 500, 20]], ['shipping_amount' => 2200]);
        [$lineA, $lineB] = $po['lines'];
        $this->assertSame([1320, 550], [$lineA['landed_unit_cost_amount'], $lineB['landed_unit_cost_amount']]);

        $body = $this->receive($h, $store, $po['id'], [
            ['item_id' => $lineA['id'], 'received' => 4, 'damaged' => 1], ['item_id' => $lineB['id'], 'received' => 20],
        ], ['supplier_invoice_ref' => 'INV-77', 'note' => ' First lot '])->assertCreated()->json('data');

        $this->assertSame(['partially_received', 24, 1, 5], [$body['status'], $body['units_received'], $body['units_damaged'], $body['units_left']]);
        $this->assertSame(16280, $body['received_value_amount']); // 4 × 1 320 + 20 × 550 (damaged excluded)
        $this->assertSame('2026-12-20', $body['due_on']); // first receipt + 30 days
        $this->assertSame(16280, $body['balance_amount']);
        $this->assertSame([14, 20], [$this->onHand($tenant, $a), $this->onHand($tenant, $b)]); // damaged never stocked
        $this->assertSame(1091, $this->costOf($tenant, $a)); // (10 × 1 000 + 4 × 1 320) ÷ 14 = 1 091.43
        $this->assertSame(550, $this->costOf($tenant, $b)); // null old cost → landed

        $receipt = $body['receipts'][0];
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $receipt['received_by']);
        $this->assertSame(['INV-77', 'First lot', 24, 1, 16280], [$receipt['supplier_invoice_ref'], $receipt['note'], $receipt['units_received'], $receipt['units_damaged'], $receipt['value_amount']]);
        $this->assertSame([
            'item_id' => $lineA['id'], 'variant_id' => $a, 'quantity_received' => 4, 'quantity_damaged' => 1,
            'landed_unit_cost_amount' => 1320, 'cost_before_amount' => 1000, 'cost_after_amount' => 1091, 'on_hand_before' => 10,
        ], collect($receipt['lines'])->firstWhere('item_id', $lineA['id']));
        $this->assertSame([null, 550, 0], array_values(array_intersect_key(collect($receipt['lines'])->firstWhere('item_id', $lineB['id']), array_flip(['cost_before_amount', 'cost_after_amount', 'on_hand_before']))));

        // S171: ledger rows through InventoryService with the PO reference.
        $moves = $this->api($h, 'GET', $this->pUrl($store, '/inventory/movements?filter[reference_type]=purchase_order'))->assertOk()->json('data');
        $this->assertCount(2, $moves);
        foreach ($moves as $m) {
            $this->assertSame(['received', ['type' => 'purchase_order', 'id' => $po['id']]], [$m['reason'], $m['reference']]);
            $this->assertStringContainsString($po['number'].' · Rahman Fabrics', (string) $m['note']);
        }
        $this->assertEqualsCanonicalizing([[4, 14], [20, 20]], array_map(fn ($m) => [$m['delta'], $m['on_hand_after']], $moves));
        $this->assertCount(0, $this->api($h, 'GET', $this->pUrl($store, '/inventory/movements?filter[reference_type]=order'))->json('data'));
        $this->api($h, 'GET', $this->pUrl($store, '/inventory/movements?filter[reference_type]=nope'))->assertUnprocessable();

        // Over-receive: 5 left on A.
        $this->receive($h, $store, $po['id'], [['item_id' => $lineA['id'], 'received' => 5, 'damaged' => 1]])
            ->assertStatus(422)->assertJsonPath('error.code', 'over_receive')->assertJsonPath('error.details', ['lines.0.received' => ['Only 5 left to receive.']]);
        $this->assertSame(14, $this->onHand($tenant, $a));

        $done = $this->receive($h, $store, $po['id'], [['item_id' => $lineA['id'], 'received' => 5]])->assertCreated()->json('data');
        $this->assertSame(['received', 0, 22880], [$done['status'], $done['units_left'], $done['received_value_amount']]);
        $this->assertSame(19, $this->onHand($tenant, $a));
        $this->assertSame(1151, $this->costOf($tenant, $a)); // (14 × 1 091 + 5 × 1 320) ÷ 19 = 1 151.26
        $this->assertSame('2026-12-20', $done['due_on']); // due date stays from the first receipt
        $this->assertCount(2, $done['receipts']);
        $this->assertSame(['created', 'marked_ordered', 'received', 'received'], array_column($done['events'], 'type'));
        $this->assertSame([24, 1], [$done['events'][2]['units'], $done['events'][2]['damaged']]);

        // received → no more receipts (409); the inventory INCOMING is 0.
        $this->receive($h, $store, $po['id'], [['item_id' => $lineA['id'], 'received' => 1]])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $inv = collect($this->api($h, 'GET', $this->pUrl($store, '/inventory'))->assertOk()->json('data'))->keyBy('variant_id');
        $this->assertSame([0, 0], [$inv[$a]['incoming'], $inv[$b]['incoming']]);

        $audit = array_values(array_filter($this->purchasingAudit($tenant), fn ($r) => $r['action'] === 'purchasing.receipt_recorded'));
        $this->assertCount(2, $audit);
        $this->assertSame(['variant_id' => $a, 'received' => 4, 'damaged' => 1, 'landed_unit_cost' => 1320, 'cost_before' => 1000, 'cost_after' => 1091], $audit[0]['meta']['lines'][0]);
        $this->assertSame('user', $audit[0]['actor_type']);
    }

    public function test_damaged_only_receipt_changes_neither_stock_nor_cost_and_can_complete_a_po(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, stock: 3, cost: 800);
        $supplier = $this->addSupplier($h, $store);
        $po = $this->ordered($h, $store, $supplier['id'], [[$a, 1000, 2]]);
        $item = $po['lines'][0]['id'];

        $body = $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 0, 'damaged' => 2]])->assertCreated()->json('data');
        $this->assertSame(['received', 0, 0], [$body['status'], $body['received_value_amount'], $body['units_left']]); // Q213
        $this->assertSame([3, 800], [$this->onHand($tenant, $a), $this->costOf($tenant, $a)]);
        $this->assertSame([800, 800], [$body['receipts'][0]['lines'][0]['cost_before_amount'], $body['receipts'][0]['lines'][0]['cost_after_amount']]);
        $this->assertSame(0, $this->platformTable('inventory_movements')->where('tenant_id', $tenant->id)->where('reference_type', 'purchase_order')->count());
    }

    #[Group('security')]
    public function test_validation_state_and_the_idempotency_key(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store);
        $draft = $this->draft($h, $store, $supplier['id'], [[$a, 100, 5]]);
        $item = $draft['lines'][0]['id'];

        $this->receive($h, $store, $draft['id'], [['item_id' => $item, 'received' => 1]])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', $this->pUrl($store, "/purchase-orders/{$draft['id']}/receipts"), ['lines' => [['item_id' => $item, 'received' => 1, 'damaged' => 0]]])
            ->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');

        $po = $this->ordered($h, $store, $supplier['id'], [[$this->variant($h, $store), 100, 5]]);
        $item = $po['lines'][0]['id'];
        foreach ([
            ['lines' => []], ['lines' => [['item_id' => $item, 'received' => -1]]], ['lines' => [['item_id' => $item, 'received' => 1.5]]],
            ['lines' => [['item_id' => $item, 'received' => '2']]], ['lines' => [['item_id' => $item]]],
            ['lines' => [['item_id' => $item, 'received' => 1]], 'note' => str_repeat('n', 501)],
            ['lines' => [['item_id' => $item, 'received' => 1]], 'supplier_invoice_ref' => str_repeat('r', 61)],
        ] as $bad) {
            $this->api($h + ['Idempotency-Key' => (string) Str::uuid()], 'POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/receipts"), $bad)
                ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        }
        $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 0]])->assertUnprocessable()->assertJsonPath('error.details.lines.0', 'Enter at least one received or damaged quantity.');
        $this->receive($h, $store, $po['id'], [['item_id' => $draft['lines'][0]['id'], 'received' => 1]])->assertUnprocessable()->assertJsonValidationErrorFor('lines.0.item_id', 'error.details');

        // S170: a retried request with the same key creates one receipt and one movement.
        $key = 'receipt-'.Str::random(12);
        $first = $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 2]], [], $key)->assertCreated();
        $again = $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 2]], [], $key)->assertCreated();
        $again->assertHeader('Idempotent-Replayed', 'true');
        $this->assertSame($first->json('data.receipts.0.id'), $again->json('data.receipts.0.id'));
        $this->assertSame(1, $this->platformTable('purchase_receipts')->where('tenant_id', $tenant->id)->where('purchase_order_id', $po['id'])->count());
        $this->assertSame(1, $this->platformTable('inventory_movements')->where('tenant_id', $tenant->id)->where('reference_id', $po['id'])->count());
        $this->receive($h, $store, $po['id'], [['item_id' => $item, 'received' => 3]], [], $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
    }

    #[Group('security')]
    public function test_an_inventory_adjust_only_receiver_sees_quantities_only_and_still_updates_cost(): void
    {
        [, $tenant, $store, $h] = $this->buyer('shop', Plan::GROWTH); // custom roles need Growth
        $a = $this->variant($h, $store, stock: 4, cost: 1000);
        $supplier = $this->addSupplier($h, $store);
        $po = $this->ordered($h, $store, $supplier['id'], [[$a, 2000, 4]]);
        $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$supplier['id']}/payments"), ['amount' => 3000, 'method' => 'cash', 'paid_on' => self::TODAY, 'purchase_order_id' => $po['id']])->assertCreated();

        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF); // has inventory.adjust, not purchasing.manage
        [, $only] = $this->memberWithRole($tenant, $this->customRole($h, 'Receiver', ['inventory.adjust']));
        foreach ([$staff, $only] as $who) {
            $list = $this->api($who, 'GET', $this->pUrl($store, '/purchase-orders'))->assertOk()->json('data.0');
            $this->assertNull($list['total_amount']);
            $this->assertNull($list['payment_status']);
            $detail = $this->getPo($who, $store, $po['id'])->assertOk()->json('data');
            foreach (['subtotal_amount', 'shipping_amount', 'discount_amount', 'total_amount', 'received_value_amount', 'paid_amount', 'balance_amount', 'payment_status'] as $f) {
                $this->assertNull($detail[$f], $f);
            }
            $this->assertNull($detail['supplier']['owed_amount']);
            $this->assertSame([null, null, null, null], [$detail['lines'][0]['unit_cost_amount'], $detail['lines'][0]['line_total_amount'], $detail['lines'][0]['landed_unit_cost_amount'], $detail['lines'][0]['last_bought_unit_cost_amount']]);
            $this->assertSame([], $detail['payments']);
            foreach (['/purchase-orders/summary', '/suppliers', "/suppliers/{$supplier['id']}", "/purchase-orders/{$po['id']}/pdf", '/purchasing/reorder-suggestions'] as $path) {
                $this->api($who, 'GET', $this->pUrl($store, $path))->assertForbidden();
            }
            $this->api($who, 'POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/close"))->assertForbidden();
        }

        // Sent costs are ignored (there is no cost input on a receipt); the cost still moves (§5.4).
        $body = $this->receive($staff, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 4, 'unit_cost_amount' => 1]], ['value_amount' => 1])->assertCreated()->json('data');
        $this->assertNull($body['receipts'][0]['value_amount']);
        $this->assertSame([null, null, null], [$body['receipts'][0]['lines'][0]['landed_unit_cost_amount'], $body['receipts'][0]['lines'][0]['cost_before_amount'], $body['receipts'][0]['lines'][0]['cost_after_amount']]);
        $this->assertSame(['received', 4], [$body['status'], $body['units_received']]);
        $this->assertSame(1500, $this->costOf($tenant, $a)); // (4 × 1 000 + 4 × 2 000) ÷ 8
        $this->assertSame(8000, $this->getPo($h, $store, $po['id'])->json('data.received_value_amount'));
        $this->assertSame('payment_recorded', collect($body['events'])->firstWhere('type', 'payment_recorded')['type']);
        $this->assertNull(collect($body['events'])->firstWhere('type', 'payment_recorded')['amount']);
    }

    #[Group('security')]
    public function test_past_profit_is_unchanged_and_new_orders_snapshot_the_new_cost_and_nothing_reaches_expenses(): void
    {
        [, $tenant, $store, $h] = $this->buyer('growth', Plan::GROWTH);
        $a = $this->variant($h, $store, stock: 10, cost: 1000, price: 3000);
        $old = $this->manual($h, $store, $this->manualBody($a, 2))->assertCreated()->json('data.id');
        $this->inTenant($tenant, fn () => Order::query()->whereKey($old)->update([
            'status' => 'delivered', 'placed_at' => '2026-10-10 06:00:00', 'delivered_at' => '2026-10-12 06:00:00',
        ]));
        $range = ['from' => '2026-10-01', 'to' => '2026-10-31'];
        $before = $this->report($h, $store, 'profit', $range)->assertOk()->json('data');

        $supplier = $this->addSupplier($h, $store);
        $po = $this->ordered($h, $store, $supplier['id'], [[$a, 2000, 8]]);
        $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 8]])->assertCreated();
        $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$supplier['id']}/payments"), ['amount' => 16000, 'method' => 'bank', 'paid_on' => self::TODAY])->assertCreated();
        $this->quick($h, $store, ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $a, 'unit_cost_amount' => 2000, 'quantity' => 1]]])->assertCreated();

        $this->assertNotSame(1000, $this->costOf($tenant, $a));
        $this->assertSame($before, $this->report($h, $store, 'profit', $range)->assertOk()->json('data')); // S172 past P&L identical
        $this->assertSame(1000, (int) $this->platformTable('order_items')->where('tenant_id', $tenant->id)->where('order_id', $old)->value('unit_cost_amount'));

        $new = $this->manual($h, $store, $this->manualBody($a, 1))->assertCreated()->json('data.id');
        $this->assertSame($this->costOf($tenant, $a), (int) $this->platformTable('order_items')->where('tenant_id', $tenant->id)->where('order_id', $new)->value('unit_cost_amount'));

        // S175: no purchasing action writes `expenses`; the expenses summary is untouched.
        $this->assertSame(0, DB::table('expenses')->count());
        $this->api($h, 'GET', $this->pUrl($store, '/expenses/summary'))->assertOk()->assertJsonPath('data.total_amount', 0);
    }
}
