<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use App\Domain\Purchasing\Models\PurchaseOrder;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8B §5.1, §5.2, §5.6, §6.2: create/edit, the state machine, list + KPIs, PDF, isolation (S167), S173. */
#[Group('purchasing')]
class PurchaseOrdersApiTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPurchasing();
    }

    #[Group('security')]
    public function test_create_numbers_defaults_and_server_side_totals(): void
    {
        [$owner, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, cost: 900);
        $b = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store, ['name' => 'Karim Traders']);
        $other = $this->addSupplier($h, $store, ['name' => 'Other']);

        $first = $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), [
            'supplier_id' => $supplier['id'], 'expected_on' => '2026-11-25', 'shipping_amount' => 500, 'discount_amount' => 200, 'notes' => ' Call first ',
            'lines' => [['variant_id' => $a, 'quantity' => 3], ['variant_id' => $b, 'quantity' => 2]],
            'subtotal_amount' => 1, 'total_amount' => 1, 'currency' => 'USD', 'status' => 'received', 'number' => 'PO-9999',
        ])->assertCreated()->json('data');
        $this->assertSame(['PO-0001', 'draft', 'BDT', 'Call first', '2026-11-25', 1], [$first['number'], $first['status'], $first['currency'], $first['notes'], $first['expected_on'], $first['revision']]);
        $this->assertSame([900, 0], array_column($first['lines'], 'unit_cost_amount')); // variant cost, else 0
        $this->assertSame([2700, 500, 200, 3000, 0, 0, 'unpaid'], [$first['subtotal_amount'], $first['shipping_amount'], $first['discount_amount'], $first['total_amount'], $first['received_value_amount'], $first['paid_amount'], $first['payment_status']]);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $first['created_by']);
        $this->assertSame([10, 10], array_column($first['lines'], 'in_stock'));

        // Bought from this supplier at 1 100 → the next PO for the same supplier defaults to it; another supplier → variant cost.
        $this->ordered($h, $store, $supplier['id'], [[$a, 1100, 1]]);
        $third = $this->draft($h, $store, $supplier['id'], [[$a, 0, 1]]);
        $this->assertSame('PO-0003', $third['number']);
        $next = $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $a, 'quantity' => 1]]])->assertCreated()->json('data');
        $this->assertSame(1100, $next['lines'][0]['unit_cost_amount']);
        $this->assertSame(1100, $next['lines'][0]['last_bought_unit_cost_amount']);
        $fromOther = $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $other['id'], 'lines' => [['variant_id' => $a, 'quantity' => 1]]])->assertCreated()->json('data');
        $this->assertSame(900, $fromOther['lines'][0]['unit_cost_amount']);

        // Another store gets its own sequence.
        [, , $store2, $h2] = $this->buyer('second');
        $s2 = $this->addSupplier($h2, $store2);
        $this->assertSame('PO-0001', $this->draft($h2, $store2, $s2['id'], [[$this->variant($h2, $store2), 10, 1]])['number']);

        $audit = $this->purchasingAudit($tenant);
        $this->assertSame('purchasing.purchase_order_created', $audit[2]['action']);
        $this->assertSame(['number' => 'PO-0001', 'supplier_id' => $supplier['id'], 'status' => 'draft', 'total_amount' => 3000, 'currency' => 'BDT', 'lines_count' => 2], $audit[2]['meta']);
    }

    #[Group('security')]
    public function test_validation(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store);
        $ok = ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $a, 'unit_cost_amount' => 100, 'quantity' => 1]]];
        $bad = [
            'supplier_id' => [null, 'x', strtolower((string) Str::ulid())],
            'lines' => [[], null, array_fill(0, 201, ['variant_id' => $a, 'quantity' => 1])],
            'lines.0.quantity' => [0, 100001, 1.5, '3'],
            'lines.0.unit_cost_amount' => [-1, 1_000_000_001, 'a'],
            'lines.0.variant_id' => [strtolower((string) Str::ulid()), 'short'],
            'expected_on' => ['2019-12-31', '2027-11-21', '20-11-2026'],
            'shipping_amount' => [-1, 'x'],
            'discount_amount' => [-1],
            'notes' => [str_repeat('n', 1001)],
            'revision' => [1],
        ];
        foreach ($bad as $field => $values) {
            foreach ($values as $value) {
                $body = $ok;
                data_set($body, $field, $value);
                $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), $body)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
            }
        }
        // discount > subtotal + shipping, duplicate variant → 422 validation_failed.
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), $ok + ['shipping_amount' => 50, 'discount_amount' => 151])
            ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonValidationErrorFor('discount_amount', 'error.details');
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $a, 'quantity' => 1], ['variant_id' => strtoupper($a), 'quantity' => 2]]])
            ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        // untracked → 422 variant_not_tracked
        $untracked = $this->stocked($h, $store, 1000, 0, ['track_inventory' => false])[1];
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $untracked, 'quantity' => 1]]])
            ->assertUnprocessable()->assertJsonPath('error.code', 'variant_not_tracked')->assertJsonValidationErrorFor('lines.0.variant_id', 'error.details');
        // a variant / supplier of another tenant → 422 unknown
        [, , $storeB, $hB] = $this->buyer('other');
        $foreign = $this->variant($hB, $storeB);
        $foreignSupplier = $this->addSupplier($hB, $storeB);
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $supplier['id'], 'lines' => [['variant_id' => $foreign, 'quantity' => 1]]])->assertUnprocessable();
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), ['supplier_id' => $foreignSupplier['id']] + $ok)->assertUnprocessable();
        // archived supplier
        $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$supplier['id']}/archive"))->assertOk();
        $this->api($h, 'POST', $this->pUrl($store, '/purchase-orders'), $ok)->assertUnprocessable()->assertJsonValidationErrorFor('supplier_id', 'error.details');
        $this->assertSame(0, $this->platformQuery(PurchaseOrder::class)->where('tenant_id', $tenant->id)->count());
    }

    public function test_patch_revision_lines_and_editable_states(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $b = $this->variant($h, $store);
        $c = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store);
        $other = $this->addSupplier($h, $store);
        $po = $this->draft($h, $store, $supplier['id'], [[$a, 100, 5], [$b, 200, 2]]);
        $url = $this->pUrl($store, "/purchase-orders/{$po['id']}");

        $this->api($h, 'PATCH', $url, ['notes' => 'x'])->assertUnprocessable()->assertJsonValidationErrorFor('revision', 'error.details');
        $this->api($h, 'PATCH', $url, ['revision' => 9, 'notes' => 'x'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');

        $patched = $this->api($h, 'PATCH', $url, ['revision' => 1, 'supplier_id' => $other['id'], 'shipping_amount' => 300, 'expected_on' => '2026-12-01',
            'lines' => [['variant_id' => $b, 'quantity' => 4], ['variant_id' => $c, 'unit_cost_amount' => 50, 'quantity' => 10]]])->assertOk()->json('data');
        $this->assertSame([2, $other['id'], 300, '2026-12-01'], [$patched['revision'], $patched['supplier']['id'], $patched['shipping_amount'], $patched['expected_on']]);
        $this->assertSame([[$b, 200, 4], [$c, 50, 10]], array_map(fn ($l) => [$l['variant_id'], $l['unit_cost_amount'], $l['quantity_ordered']], $patched['lines']));
        $this->assertSame([1300, 1600], [$patched['subtotal_amount'], $patched['total_amount']]);
        $this->assertSame($po['lines'][1]['id'], $patched['lines'][0]['id']); // matched by variant: the line keeps its id

        // ordered: still editable, but not the supplier.
        $ordered = $this->api($h, 'POST', $this->pUrl($store, "/purchase-orders/{$po['id']}/mark-ordered"), ['revision' => 2])->assertOk()->json('data');
        $this->assertSame(['ordered', 3, null], [$ordered['status'], $ordered['revision'], $ordered['sent_via']]);
        $this->assertNotNull($ordered['ordered_at']);
        $this->api($h, 'PATCH', $url, ['revision' => 3, 'supplier_id' => $supplier['id']])->assertUnprocessable()->assertJsonValidationErrorFor('supplier_id', 'error.details');
        $this->api($h, 'PATCH', $url, ['revision' => 3, 'discount_amount' => 100])->assertOk()->assertJsonPath('data.total_amount', 1500);

        // partially received → no edits (P88B-2).
        $this->receive($h, $store, $po['id'], [['item_id' => $patched['lines'][0]['id'], 'received' => 1]])->assertCreated();
        $this->api($h, 'PATCH', $url, ['revision' => 5, 'notes' => 'late'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        $actions = array_column($this->purchasingAudit($tenant), 'action');
        $this->assertSame(2, count(array_keys($actions, 'purchasing.purchase_order_updated', true)));
    }

    public function test_state_machine(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $supplier = $this->addSupplier($h, $store);
        $go = fn (string $id, string $action, array $body = []) => $this->api($h, 'POST', $this->pUrl($store, "/purchase-orders/{$id}/{$action}"), $body);
        $conflict = fn ($r) => $r->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');

        // draft: send, mark-ordered, cancel, delete allowed; close not.
        $d = $this->draft($h, $store, $supplier['id'], [[$a, 10, 2]]);
        $conflict($go($d['id'], 'close'));
        $go($d['id'], 'send')->assertUnprocessable()->assertJsonValidationErrorFor('sent_via', 'error.details');
        $go($d['id'], 'send', ['sent_via' => 'email'])->assertUnprocessable();
        $go($d['id'], 'send', ['sent_via' => 'pdf', 'revision' => 7])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $sent = $go($d['id'], 'send', ['sent_via' => 'whatsapp', 'revision' => 1])->assertOk()->json('data');
        $this->assertSame(['ordered', 'whatsapp'], [$sent['status'], $sent['sent_via']]);
        $this->assertNotNull($sent['sent_at']);
        $go($d['id'], 'send', ['sent_via' => 'pdf'])->assertOk()->assertJsonPath('data.sent_via', 'pdf'); // re-send while ordered
        $conflict($go($d['id'], 'mark-ordered'));
        $conflict($this->api($h, 'DELETE', $this->pUrl($store, "/purchase-orders/{$d['id']}")));
        $cancelled = $go($d['id'], 'cancel')->assertOk()->json('data');
        $this->assertSame('cancelled', $cancelled['status']);
        $this->assertNotNull($cancelled['cancelled_at']);
        foreach (['send', 'mark-ordered', 'close', 'cancel'] as $action) {
            $conflict($go($d['id'], $action, $action === 'send' ? ['sent_via' => 'pdf'] : []));
        }

        // partially received: close allowed, cancel not.
        $p = $this->ordered($h, $store, $supplier['id'], [[$a, 10, 5]]);
        $this->receive($h, $store, $p['id'], [['item_id' => $p['lines'][0]['id'], 'received' => 2]])->assertCreated();
        $conflict($go($p['id'], 'cancel'));
        $closed = $go($p['id'], 'close')->assertOk()->json('data');
        $this->assertSame(['closed', 0], [$closed['status'], $closed['units_left']]);
        $inv = collect($this->api($h, 'GET', $this->pUrl($store, '/inventory'))->json('data'))->keyBy('variant_id');
        $this->assertSame(0, $inv[$a]['incoming']); // closed: remaining stop counting as incoming
        $conflict($this->receive($h, $store, $p['id'], [['item_id' => $p['lines'][0]['id'], 'received' => 1]]));

        // delete a draft (and an advance paid on it stays with the supplier).
        $x = $this->draft($h, $store, $supplier['id'], [[$a, 10, 1]]);
        $pay = $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$supplier['id']}/payments"), ['amount' => 500, 'method' => 'cash', 'paid_on' => self::TODAY, 'purchase_order_id' => $x['id']])->assertCreated()->json('data');
        $this->assertSame(['id' => $x['id'], 'number' => $x['number']], $pay['purchase_order']);
        $this->api($h, 'DELETE', $this->pUrl($store, "/purchase-orders/{$x['id']}"))->assertNoContent();
        $this->getPo($h, $store, $x['id'])->assertNotFound();
        $this->assertNull($this->api($h, 'GET', $this->pUrl($store, "/suppliers/{$supplier['id']}/payments"))->json('data.0.purchase_order'));

        $actions = array_column($this->purchasingAudit($tenant), 'action');
        foreach (['purchasing.purchase_order_sent', 'purchasing.purchase_order_cancelled', 'purchasing.purchase_order_closed', 'purchasing.purchase_order_marked_ordered', 'purchasing.purchase_order_deleted'] as $a) {
            $this->assertContains($a, $actions);
        }
    }

    public function test_list_filters_counts_late_flag_and_summary(): void
    {
        [, , $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, name: 'Cotton Panjabi');
        $b = $this->variant($h, $store);
        $karim = $this->addSupplier($h, $store, ['name' => 'Karim Traders', 'payment_terms_days' => 3]);
        $nila = $this->addSupplier($h, $store, ['name' => 'Nila Textiles']);
        $this->draft($h, $store, $karim['id'], [[$a, 100, 1]]);
        $late = $this->ordered($h, $store, $karim['id'], [[$a, 1000, 10], [$b, 500, 4]], ['expected_on' => '2026-11-25']);
        $this->travelTo(now()->addDays(8)); // 28 Nov: the PO expected on the 25th is 3 days late
        $partial = $this->ordered($h, $store, $nila['id'], [[$b, 200, 5]], ['expected_on' => '2026-11-30']);
        $this->receive($h, $store, $late['id'], [['item_id' => $late['lines'][0]['id'], 'received' => 4]])->assertCreated();

        $list = $this->api($h, 'GET', $this->pUrl($store, '/purchase-orders'))->assertOk();
        $this->assertSame(['all' => 3, 'draft' => 1, 'ordered' => 1, 'partially_received' => 1, 'received' => 0, 'closed' => 0, 'cancelled' => 0], $list->json('meta.counts'));
        $this->assertSame([$partial['number'], $late['number'], 'PO-0001'], array_column($list->json('data'), 'number'));
        $row = collect($list->json('data'))->firstWhere('id', $late['id']);
        $this->assertSame([true, 3, 2, 14, 4, 10], [$row['is_late'], $row['days_late'], $row['lines_count'], $row['units_ordered'], $row['units_received'], $row['units_left']]);
        $this->assertSame(['product_name' => 'Cotton Panjabi'], array_intersect_key($row['preview_items'][0], ['product_name' => 1]));
        $this->assertSame(['id' => $karim['id'], 'name' => 'Karim Traders', 'phone' => null, 'city' => null], $row['supplier']);

        $this->assertSame([$partial['id']], array_column($this->api($h, 'GET', $this->pUrl($store, '/purchase-orders?filter[status]=ordered'))->json('data'), 'id'));
        $this->assertCount(2, $this->api($h, 'GET', $this->pUrl($store, "/purchase-orders?filter[supplier_id]={$karim['id']}"))->json('data'));
        $this->assertSame([$partial['id']], array_column($this->api($h, 'GET', $this->pUrl($store, '/purchase-orders?q=nila'))->json('data'), 'id'));
        $this->assertSame([$late['id']], array_column($this->api($h, 'GET', $this->pUrl($store, '/purchase-orders?q='.strtolower($late['number'])))->json('data'), 'id'));
        $this->api($h, 'GET', $this->pUrl($store, '/purchase-orders?filter[status]=lost'))->assertUnprocessable();

        $s = $this->api($h, 'GET', $this->pUrl($store, '/purchase-orders/summary'))->assertOk()->json('data');
        $this->assertSame([
            'currency' => 'BDT', 'open_count' => 2, 'open_total_amount' => 12000 + 1000, 'units_coming' => 10 + 5, 'suppliers_coming' => 2,
            'owed_amount' => 4000, 'payments_due_this_week' => 1, 'late_count' => 1,
            'first_late' => ['id' => $late['id'], 'number' => $late['number'], 'days_late' => 3],
        ], $s);
    }

    public function test_pdf(): void
    {
        [, , $store, $h] = $this->buyer();
        $a = $this->variant($h, $store, name: 'Jamdani Saree');
        $supplier = $this->addSupplier($h, $store, ['name' => 'Tangail Weavers <b>', 'phone' => '01712345678']);
        $po = $this->draft($h, $store, $supplier['id'], [[$a, 150000, 2]], ['shipping_amount' => 5000, 'notes' => 'Pack well']);

        $r = $this->api($h, 'GET', $this->pUrl($store, "/purchase-orders/{$po['id']}/pdf"))->assertOk();
        $r->assertHeader('Content-Disposition', 'inline; filename="'.$po['number'].'.pdf"');
        $r->assertHeader('X-Content-Type-Options', 'nosniff');
        $html = (string) $r->getContent();
        foreach ([$po['number'], 'Jamdani Saree', 'Tangail Weavers &lt;b&gt;', '01712345678', '৳ 3,000', '৳ 50', '৳ 3,050', 'Pack well'] as $needle) {
            $this->assertStringContainsString($needle, $html);
        }
        $this->assertStringNotContainsString('Tangail Weavers <b>', $html);
    }

    #[Group('security')]
    public function test_isolation_permissions_and_plan(): void
    {
        [, $tenantA, $storeA, $hA] = $this->buyer('alpha');
        [, , $storeB, $hB] = $this->buyer('beta');
        $supB = $this->addSupplier($hB, $storeB);
        $poB = $this->ordered($hB, $storeB, $supB['id'], [[$this->variant($hB, $storeB), 10, 2]]);
        $itemB = $poB['lines'][0]['id'];

        // S167: B's ids through A's store → 404 (cross-tenant).
        foreach ([
            ['GET', "/purchase-orders/{$poB['id']}"], ['PATCH', "/purchase-orders/{$poB['id']}"], ['DELETE', "/purchase-orders/{$poB['id']}"],
            ['POST', "/purchase-orders/{$poB['id']}/close"], ['GET', "/purchase-orders/{$poB['id']}/pdf"], ['GET', "/suppliers/{$supB['id']}"],
        ] as [$method, $path]) {
            $this->api($hA, $method, $this->pUrl($storeA, $path), ['revision' => 1])->assertNotFound();
        }
        $this->receive($hA, $storeA, $poB['id'], [['item_id' => $itemB, 'received' => 1]])->assertNotFound();
        $this->api($hA, 'GET', $this->pUrl($storeB, '/purchase-orders'))->assertNotFound(); // another tenant's store

        $this->assertStoreIsolation(PurchaseOrder::class, $tenantA, $storeA, $storeB);

        // Staff: 403 on money routes, 200 on list/detail.
        [, $staff] = $this->memberAs($tenantA, TenantUser::ROLE_STAFF);
        $supA = $this->addSupplier($hA, $storeA);
        $poA = $this->draft($hA, $storeA, $supA['id'], [[$this->variant($hA, $storeA), 10, 1]]);
        $this->api($staff, 'POST', $this->pUrl($storeA, '/purchase-orders'), ['supplier_id' => $supA['id'], 'lines' => []])->assertForbidden();
        $this->api($staff, 'POST', $this->pUrl($storeA, "/purchase-orders/{$poA['id']}/send"), ['sent_via' => 'pdf'])->assertForbidden();
        $this->api($staff, 'GET', $this->pUrl($storeA, "/purchase-orders/{$poA['id']}"))->assertOk();

        // S169 plan: Free → reads 200, writes 402 (before validation).
        [, , $free, $hF] = $this->freeBuyer();
        $this->api($hF, 'GET', $this->pUrl($free, '/purchase-orders'))->assertOk();
        $this->api($hF, 'GET', $this->pUrl($free, '/purchase-orders/summary'))->assertOk();
        $this->api($hF, 'GET', $this->pUrl($free, '/suppliers'))->assertOk();
        $this->api($hF, 'GET', $this->pUrl($free, '/suppliers/summary'))->assertOk();
        $this->api($hF, 'GET', $this->pUrl($free, '/purchasing/reorder-suggestions'))->assertOk();
        $this->api($hF, 'POST', $this->pUrl($free, '/suppliers'), [])->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($hF, 'POST', $this->pUrl($free, '/purchase-orders'), [])->assertStatus(402);
        $this->quick($hF, $free, [])->assertStatus(402);
        $this->uploadInvoice($hF, $free)->assertStatus(402);
    }
}
