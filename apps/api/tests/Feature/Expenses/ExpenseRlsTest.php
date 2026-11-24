<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S141 / S149 at the database (PHASE-8-7 §4, §9): `expenses` and `expense_recurrences` are under forced RLS; the
 * scheduler commands discover cross-tenant and work under each tenant with RLS on. TENANCY_RLS=true on Postgres only.
 */
#[Group('expenses')]
#[Group('rls')]
#[Group('security')]
class ExpenseRlsTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase;

    private const TABLES = ['expenses', 'expense_recurrences'];

    public function test_expense_tables_are_isolated_and_the_commands_run_under_rls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpExpenses();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->shop(slug: $slug);
            $this->addExpense($h, $store, ['spent_on' => '2026-11-05', 'repeat_monthly' => true]);
            $this->pdfReceipt($h, $store); // unattached, pruned below
            $shops[$slug] = [$tenant, $store];
        }
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB] = $shops['beta'];

        // The scheduler commands: discovery on the platform connection, work inside each tenant.
        $this->travelTo(now()->addMonth()->addDay());
        $this->repeat();
        $this->artisan('expenses:prune-receipts')->assertSuccessful();
        foreach ([$tenantA, $tenantB] as $tenant) {
            $this->assertCount(2, $this->expensesOf($tenant));
            $this->assertSame(0, $this->platformTable('media')->where('tenant_id', $tenant->id)->where('purpose', 'expense_receipt')->count());
        }

        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [$tenantA->id]);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into expenses (id, tenant_id, store_id, category, paid_from, amount, currency, spent_on, created_at, updated_at) values (?, ?, ?, 'ads', 'cash', 1, 'BDT', '2026-11-01', now(), now())",
                [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id]);
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
