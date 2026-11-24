<?php

declare(strict_types=1);

namespace Tests\Feature\Purchasing;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** S167 at the database (PHASE-8-8B §3): the six purchasing tables are under forced RLS. TENANCY_RLS=true on Postgres only. */
#[Group('purchasing')]
#[Group('rls')]
#[Group('security')]
class PurchasingRlsTest extends TestCase
{
    use PurchasingFixtures, RefreshDatabase;

    private const TABLES = ['suppliers', 'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'purchase_receipt_items', 'supplier_payments'];

    public function test_purchasing_tables_are_isolated(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpPurchasing();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->buyer($slug);
            $supplier = $this->addSupplier($h, $store);
            $po = $this->ordered($h, $store, $supplier['id'], [[$this->variant($h, $store), 100, 3]]);
            $this->receive($h, $store, $po['id'], [['item_id' => $po['lines'][0]['id'], 'received' => 1, 'damaged' => 1]])->assertCreated();
            $this->api($h, 'POST', $this->pUrl($store, "/suppliers/{$supplier['id']}/payments"), ['amount' => 50, 'method' => 'cash', 'paid_on' => self::TODAY, 'purchase_order_id' => $po['id']])->assertCreated();
            $shops[$slug] = [$tenant, $store, $supplier['id']];
        }
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB, $supplierB] = $shops['beta'];

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenantA->id]);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into supplier_payments (id, tenant_id, store_id, supplier_id, amount, currency, method, paid_on, created_at, updated_at) values (?, ?, ?, ?, 1, 'BDT', 'cash', '2026-11-01', now(), now())",
                [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id, $supplierB]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused);

        DB::statement("select set_config('app.tenant_id', '', false)");
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
