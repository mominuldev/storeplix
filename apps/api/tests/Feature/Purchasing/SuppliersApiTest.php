<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8B §4, §6: supplier CRUD, list + KPIs, payments, owed / overdue / due (S167, S168, S174, S178). */
#[Group('purchasing')]
class SuppliersApiTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPurchasing();
    }

    public function test_crud_archive_delete_and_audit(): void
    {
        [$owner, $tenant, $store, $h] = $this->buyer();
        $created = $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), [
            'name' => ' Rahman Fabrics ', 'contact_name' => 'Abdur Rahman', 'phone' => '+880 1711-000222', 'city' => 'Dhaka',
            'supplies' => 'Cotton fabric', 'payment_terms_days' => 30, 'advance_percent' => 20, 'lead_time_days' => 5,
            'pays_by_method' => 'bkash', 'pays_by_account' => '01711000222', 'notes' => "Islampur\nShop 4",
            'tenant_id' => 'x', 'store_id' => 'y', 'archived_at' => '2026-01-01',
        ])->assertCreated()->json('data');
        $this->assertSame([
            'name' => 'Rahman Fabrics', 'contact_name' => 'Abdur Rahman', 'phone' => '8801711000222', 'city' => 'Dhaka', 'supplies' => 'Cotton fabric',
            'payment_terms_days' => 30, 'advance_percent' => 20, 'lead_time_days' => 5, 'pays_by_method' => 'bkash', 'pays_by_account' => '01711000222',
            'notes' => "Islampur\nShop 4", 'archived_at' => null, 'products_count' => 0, 'open_pos_count' => 0, 'past_orders_count' => 0, 'currency' => 'BDT',
            'owed_amount' => 0, 'overdue_amount' => 0, 'overdue_since' => null, 'last_order_on' => null, 'active_this_month' => false,
            'created_by' => ['id' => $owner->id, 'name' => $owner->name],
        ], array_diff_key($created, array_flip(['id', 'created_at', 'updated_at'])));

        $url = $this->pUrl($store, "/suppliers/{$created['id']}");
        $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), ['name' => 'RAHMAN fabrics'])->assertUnprocessable()->assertJsonValidationErrorFor('name', 'error.details');
        $this->api($h, 'PATCH', $url, ['city' => '', 'lead_time_days' => null])->assertOk()->assertJsonPath('data.city', null)->assertJsonPath('data.lead_time_days', null);
        $this->api($h, 'GET', $url)->assertOk()->assertJsonPath('data.recent_purchase_orders', []);

        $this->api($h, 'POST', "{$url}/archive")->assertOk()->assertJsonPath('data.archived_at', now()->toIso8601ZuluString());
        $this->assertSame([], $this->api($h, 'GET', $this->pUrl($store, '/suppliers'))->json('data'));
        $this->assertSame(['active' => 0, 'archived' => 1], $this->api($h, 'GET', $this->pUrl($store, '/suppliers?filter[archived]=true'))->json('meta.counts'));
        $twin = $this->addSupplier($h, $store, ['name' => 'Rahman Fabrics']); // the archived one freed the name
        $this->api($h, 'POST', "{$url}/unarchive")->assertUnprocessable()->assertJsonValidationErrorFor('name', 'error.details');
        $this->api($h, 'DELETE', $this->pUrl($store, "/suppliers/{$twin['id']}"))->assertNoContent();
        $this->api($h, 'POST', "{$url}/unarchive")->assertOk()->assertJsonPath('data.archived_at', null);

        // In use (a PO or a payment) → 409 supplier_in_use.
        $this->draft($h, $store, $created['id'], [[$this->variant($h, $store), 10, 1]]);
        $this->api($h, 'DELETE', $url)->assertStatus(409)->assertJsonPath('error.code', 'supplier_in_use');
        $paid = $this->addSupplier($h, $store);
        $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$paid['id']}/payments"), ['amount' => 100, 'method' => 'cash', 'paid_on' => self::TODAY])->assertCreated();
        $this->api($h, 'DELETE', $this->pUrl($store, "/suppliers/{$paid['id']}"))->assertStatus(409);

        $actions = array_column($this->purchasingAudit($tenant), 'action');
        foreach (['purchasing.supplier_created', 'purchasing.supplier_updated', 'purchasing.supplier_archived', 'purchasing.supplier_unarchived', 'purchasing.supplier_deleted'] as $a) {
            $this->assertContains($a, $actions);
        }
        $deleted = collect($this->purchasingAudit($tenant))->firstWhere('action', 'purchasing.supplier_deleted');
        $this->assertSame('Rahman Fabrics', $deleted['meta']['name']);
    }

    public function test_validation(): void
    {
        [, , $store, $h] = $this->buyer();
        $bad = [
            'name' => ['', '   ', str_repeat('a', 121), null, "bad\x07"],
            'phone' => ['12345', '+14155550100'],
            'city' => [str_repeat('c', 81)],
            'supplies' => [str_repeat('s', 201)],
            'payment_terms_days' => [-1, 181, '30', 1.5],
            'advance_percent' => [101, -1],
            'lead_time_days' => [181],
            'pays_by_method' => ['paypal'],
            'pays_by_account' => [str_repeat('a', 61)],
            'notes' => [str_repeat('n', 501)],
        ];
        foreach ($bad as $field => $values) {
            foreach ($values as $value) {
                $this->api($h, 'POST', $this->pUrl($store, '/suppliers'), [$field => $value] + ['name' => 'Valid'])
                    ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonValidationErrorFor($field, 'error.details');
            }
        }
    }

    #[Group('security')]
    public function test_payments_owed_overdue_payment_status_and_kpis(): void
    {
        [, $tenant, $store, $h] = $this->buyer();
        $a = $this->variant($h, $store);
        $b = $this->variant($h, $store);
        $karim = $this->addSupplier($h, $store, ['name' => 'Karim Traders', 'payment_terms_days' => 3]);
        $nila = $this->addSupplier($h, $store, ['name' => 'Nila Textiles']);

        // Karim: PO1 10 × 1 000 received now (due in 3 days); PO2 advance of 2 000 before receipt.
        $po1 = $this->ordered($h, $store, $karim['id'], [[$a, 1000, 10]]);
        $this->receive($h, $store, $po1['id'], [['item_id' => $po1['lines'][0]['id'], 'received' => 10]])->assertCreated();
        $po2 = $this->ordered($h, $store, $karim['id'], [[$b, 500, 8]], ['expected_on' => '2026-11-24']);
        $pay = fn (array $body) => $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$karim['id']}/payments"), $body + ['method' => 'cash', 'paid_on' => self::TODAY]);

        // Payment status vectors (P88B-8) on PO2 (total 4 000).
        $this->assertSame('unpaid', $this->getPo($h, $store, $po2['id'])->json('data.payment_status'));
        $p1 = $pay(['amount' => 2000, 'purchase_order_id' => $po2['id'], 'reference' => 'TRX-1'])->assertCreated()->json('data');
        $this->assertSame(['id' => $po2['id'], 'number' => $po2['number']], $p1['purchase_order']);
        $this->assertSame([2000, 'BDT', 'cash', self::TODAY, 'TRX-1'], [$p1['amount'], $p1['currency'], $p1['method'], $p1['paid_on'], $p1['reference']]);
        $this->assertSame(['partially_paid', 2000, -2000], [$this->getPo($h, $store, $po2['id'])->json('data.payment_status'), $this->getPo($h, $store, $po2['id'])->json('data.paid_amount'), $this->getPo($h, $store, $po2['id'])->json('data.balance_amount')]);
        $p2 = $pay(['amount' => 2000, 'purchase_order_id' => $po2['id']])->assertCreated()->json('data');
        $this->assertSame('paid', $this->getPo($h, $store, $po2['id'])->json('data.payment_status'));
        $p3 = $pay(['amount' => 1, 'purchase_order_id' => $po2['id']])->assertCreated()->json('data');
        $this->assertSame('overpaid', $this->getPo($h, $store, $po2['id'])->json('data.payment_status'));
        $this->api($h, 'DELETE', $this->pUrl($store, "/supplier-payments/{$p3['id']}"))->assertNoContent();
        $this->assertSame('paid', $this->getPo($h, $store, $po2['id'])->json('data.payment_status'));
        $deleted = collect($this->purchasingAudit($tenant))->firstWhere('action', 'purchasing.payment_deleted');
        $this->assertSame(['supplier_id' => $karim['id'], 'purchase_order_id' => $po2['id'], 'purchase_order_number' => $po2['number'], 'amount' => 1, 'currency' => 'BDT', 'method' => 'cash', 'paid_on' => self::TODAY, 'reference' => null, 'note' => null], $deleted['meta']);

        // Owed = received value (10 000) − payments (4 000) = 6 000; PO2's advance is credit on an unreceived PO (Q209).
        $s = $this->api($h, 'GET', $this->pUrl($store, "/suppliers/{$karim['id']}"))->assertOk()->json('data');
        $this->assertSame([6000, 0, null, 2, 2, 2, true, self::TODAY], [$s['owed_amount'], $s['overdue_amount'], $s['overdue_since'], $s['open_pos_count'] + 1, $s['past_orders_count'], $s['products_count'], $s['active_this_month'], $s['last_order_on']]);
        $this->assertSame([$po2['id'], $po1['id']], array_column($s['recent_purchase_orders'], 'id'));

        $summary = $this->api($h, 'GET', $this->pUrl($store, '/purchase-orders/summary'))->json('data');
        $this->assertSame([6000, 1], [$summary['owed_amount'], $summary['payments_due_this_week']]); // PO1 due 23 Nov, balance 10 000

        // Four days later PO1 is overdue (due 23 Nov), capped at what is owed.
        $this->travelTo(now()->addDays(4));
        $s = $this->api($h, 'GET', $this->pUrl($store, "/suppliers/{$karim['id']}"))->json('data');
        $this->assertSame([6000, '2026-11-23'], [$s['overdue_amount'], $s['overdue_since']]);
        $this->assertTrue($this->getPo($h, $store, $po1['id'])->json('data.is_overdue'));
        $list = $this->api($h, 'GET', $this->pUrl($store, '/suppliers?sort=-owed_amount'))->assertOk()->json('data');
        $this->assertSame(['Karim Traders', 'Nila Textiles'], array_column($list, 'name'));
        $this->assertSame(['Karim Traders'], array_column($this->api($h, 'GET', $this->pUrl($store, '/suppliers?q=karim'))->json('data'), 'name'));
        $this->assertSame(['Karim Traders', 'Nila Textiles'], array_column($this->api($h, 'GET', $this->pUrl($store, '/suppliers?sort=-last_order_on'))->json('data'), 'name'));

        $kpi = $this->api($h, 'GET', $this->pUrl($store, '/suppliers/summary'))->assertOk()->json('data');
        $this->assertSame([
            'currency' => 'BDT', 'suppliers_count' => 2, 'active_this_month' => 1, 'owed_amount' => 6000, 'owed_suppliers_count' => 1,
            'overdue_count' => 1, 'pos_on_the_way' => 1, 'arriving_this_week' => 1, 'bought_this_month_amount' => 10000,
        ], $kpi);

        // A supplier-level payment (no PO) lowers what is owed.
        $pay(['amount' => 6000])->assertCreated();
        $this->assertSame([0, 0], array_values(array_intersect_key($this->api($h, 'GET', $this->pUrl($store, "/suppliers/{$karim['id']}"))->json('data'), array_flip(['owed_amount', 'overdue_amount']))));
        $this->assertCount(3, $this->api($h, 'GET', $this->pUrl($store, "/suppliers/{$karim['id']}/payments"))->assertOk()->json('data'));
        $this->assertSame(0, $this->platformTable('expenses')->count()); // S175
        unset($p2, $nila);
    }

    #[Group('security')]
    public function test_payment_validation(): void
    {
        [, , $store, $h] = $this->buyer();
        $karim = $this->addSupplier($h, $store);
        $nila = $this->addSupplier($h, $store);
        $nilaPo = $this->draft($h, $store, $nila['id'], [[$this->variant($h, $store), 10, 1]]);
        $cancelled = $this->draft($h, $store, $karim['id'], [[$this->variant($h, $store), 10, 1]]);
        $this->api($h, 'POST', $this->pUrl($store, "/purchase-orders/{$cancelled['id']}/cancel"))->assertOk();
        $url = $this->pUrl($store, "/suppliers/{$karim['id']}/payments");
        $ok = ['amount' => 100, 'method' => 'cash', 'paid_on' => self::TODAY];
        $bad = [
            'amount' => [0, -1, 10_000_000_001, '100', 1.5],
            'method' => ['paypal', null],
            'paid_on' => ['2026-11-21', '2019-12-31', 'today'],
            'reference' => [str_repeat('r', 61)],
            'note' => [str_repeat('n', 201)],
            'purchase_order_id' => [$nilaPo['id'], $cancelled['id'], strtolower((string) Str::ulid())],
            'currency' => ['USD'],
        ];
        foreach ($bad as $field => $values) {
            foreach ($values as $value) {
                $this->api($h, 'POST', $url, [$field => $value] + $ok)->assertUnprocessable()->assertJsonValidationErrorFor($field, 'error.details');
            }
        }
        $this->api($h, 'POST', $url, $ok + ['currency' => 'BDT', 'supplier_id' => $nila['id']])->assertCreated()->assertJsonPath('data.supplier.id', $karim['id']);
    }

    #[Group('security')]
    public function test_isolation_permissions_and_impersonation(): void
    {
        [, $tenantA, $storeA, $hA] = $this->buyer('alpha');
        [, , $storeB, $hB] = $this->buyer('beta');
        $supB = $this->addSupplier($hB, $storeB);
        $payB = $this->api($hB, 'POST', $this->pUrl($storeB, "/suppliers/{$supB['id']}/payments"), ['amount' => 100, 'method' => 'cash', 'paid_on' => self::TODAY])->json('data');
        foreach ([['GET', "/suppliers/{$supB['id']}"], ['PATCH', "/suppliers/{$supB['id']}"], ['DELETE', "/suppliers/{$supB['id']}"],
            ['POST', "/suppliers/{$supB['id']}/archive"], ['GET', "/suppliers/{$supB['id']}/payments"], ['POST', "/suppliers/{$supB['id']}/payments"],
            ['DELETE', "/supplier-payments/{$payB['id']}"]] as [$method, $path]) {
            $this->api($hA, $method, $this->pUrl($storeA, $path), ['amount' => 1, 'method' => 'cash', 'paid_on' => self::TODAY])->assertNotFound();
        }
        $this->assertStoreIsolation(Supplier::class, $tenantA, $storeA, $storeB);
        $this->assertStoreIsolation(SupplierPayment::class, $tenantA, $storeA, $storeB);

        // S168: staff (no purchasing.manage) → 403 on every supplier route.
        $supA = $this->addSupplier($hA, $storeA);
        [, $staff] = $this->memberAs($tenantA, TenantUser::ROLE_STAFF);
        foreach ([['GET', '/suppliers'], ['GET', '/suppliers/summary'], ['POST', '/suppliers'], ['GET', "/suppliers/{$supA['id']}"],
            ['PATCH', "/suppliers/{$supA['id']}"], ['GET', "/suppliers/{$supA['id']}/payments"], ['POST', "/suppliers/{$supA['id']}/payments"]] as [$method, $path]) {
            $this->api($staff, $method, $this->pUrl($storeA, $path), ['name' => 'X'])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
    }
}
