<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Billing\Models\Plan;
use App\Domain\Expenses\ExpenseRevision;
use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Tenancy\Models\TenantUser;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-8-7 §6, §8: the ledger routes (happy path, validation S147, permissions S142, isolation S141, audit S151). */
#[Group('expenses')]
class ExpensesApiTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase, StorefrontContent;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpExpenses();
    }

    public function test_create_list_show_update_delete_with_audit(): void
    {
        [$owner, $tenant, $store, $h] = $this->shop();

        $created = $this->api($h, 'POST', $this->eUrl($store), [
            'amount' => 250000, 'category' => 'rent_bills', 'paid_from' => 'bank', 'spent_on' => '2026-11-01', 'note' => '  November rent  ',
        ])->assertCreated()->json('data');
        $this->assertSame([
            'category' => 'rent_bills', 'paid_from' => 'bank', 'amount' => 250000, 'currency' => 'BDT', 'spent_on' => '2026-11-01',
            'note' => 'November rent', 'receipt' => null, 'repeat_monthly' => false, 'recurrence_id' => null,
            'created_by' => ['id' => $owner->id, 'name' => $owner->name],
        ], array_intersect_key($created, array_flip(['category', 'paid_from', 'amount', 'currency', 'spent_on', 'note', 'receipt', 'repeat_monthly', 'recurrence_id', 'created_by'])));
        $this->assertSame(26, strlen($created['id']));

        $ads = $this->addExpense($h, $store, ['amount' => 5000, 'category' => 'ads', 'paid_from' => 'card', 'spent_on' => '2026-11-15']);
        $this->addExpense($h, $store, ['spent_on' => '2026-10-31']); // previous month: not listed for November

        $list = $this->api($h, 'GET', $this->eUrl($store))->assertOk();
        $this->assertSame([$ads['id'], $created['id']], array_column($list->json('data'), 'id'));
        $this->assertSame(50, $list->json('meta.per_page'));
        $this->assertSame([$ads['id']], array_column($this->api($h, 'GET', $this->eUrl($store, '?filter[category]=ads'))->assertOk()->json('data'), 'id'));
        $this->assertCount(1, $this->api($h, 'GET', $this->eUrl($store, '?filter[month]=2026-10'))->assertOk()->json('data'));
        $this->api($h, 'GET', $this->eUrl($store, '?filter[category]=fuel'))->assertUnprocessable();
        $this->api($h, 'GET', $this->eUrl($store, '?filter[month]=2026-12'))->assertUnprocessable();
        $this->api($h, 'GET', $this->eUrl($store, '?filter[month]=2019-12'))->assertUnprocessable();

        $this->api($h, 'GET', $this->eUrl($store, "/{$created['id']}"))->assertOk()->assertJsonPath('data.amount', 250000);

        $this->api($h, 'PATCH', $this->eUrl($store, "/{$created['id']}"), ['amount' => 260000, 'spent_on' => '2026-11-02', 'note' => ''])
            ->assertOk()->assertJsonPath('data.amount', 260000)->assertJsonPath('data.note', null)->assertJsonPath('data.spent_on', '2026-11-02');

        $this->api($h, 'DELETE', $this->eUrl($store, "/{$created['id']}"))->assertNoContent();
        $this->assertNull($this->expenseRow($tenant, $created['id']));
        $this->api($h, 'GET', $this->eUrl($store, "/{$created['id']}"))->assertNotFound()->assertJsonPath('error.code', 'not_found');

        $audit = $this->auditRows($tenant);
        $this->assertSame(['expense.created', 'expense.created', 'expense.created', 'expense.updated', 'expense.deleted'], array_column($audit, 'action'));
        $this->assertSame(['category' => 'rent_bills', 'amount' => 250000, 'currency' => 'BDT', 'spent_on' => '2026-11-01'], $audit[0]['meta']);
        $this->assertSame(['amount' => [250000, 260000], 'spent_on' => ['2026-11-01', '2026-11-02']], $audit[3]['meta']['changes']);
        $this->assertSame('user', $audit[3]['actor_type']);
        $this->assertSame(260000, $audit[4]['meta']['amount']);
        $this->assertSame('bank', $audit[4]['meta']['paid_from']);
    }

    public function test_validation_and_no_mass_assignment(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $ok = ['amount' => 1000, 'category' => 'ads', 'paid_from' => 'cash', 'spent_on' => '2026-11-20'];
        $bad = [
            'amount' => [0, -5, 1_000_000_001, 10.5, '100', null],
            'category' => ['fuel', '', null],
            'paid_from' => ['wallet', null],
            'spent_on' => ['2026-11-21', '2019-12-31', '20-11-2026', '2026-02-30', null],
            'note' => [str_repeat('a', 201), "line\x07bell", ['x']],
            'currency' => ['USD', 'bdtx'],
            'repeat_monthly' => ['yes', 1],
            'receipt_id' => [str_repeat('a', 25)],
        ];
        foreach ($bad as $field => $values) {
            foreach ($values as $value) {
                $this->api($h, 'POST', $this->eUrl($store), [$field => $value] + $ok)
                    ->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')
                    ->assertJsonValidationErrorFor($field, 'error.details');
            }
        }
        $this->api($h, 'POST', $this->eUrl($store), ['spent_on' => '2026-11-21'] + $ok)
            ->assertJsonPath('error.details.spent_on.0', 'The date can’t be in the future. Use “Repeat every month” for planned costs.');
        // 23:59 Dhaka on the 20th is still "today"; the boundary is the store's local date.
        $this->travelTo(now()->setTimezone('Asia/Dhaka')->setTime(23, 59)->utc());
        $this->api($h, 'POST', $this->eUrl($store), ['spent_on' => '2026-11-20', 'amount' => 1_000_000_000] + $ok)->assertCreated();

        $other = strtolower((string) Str::ulid());
        $row = $this->api($h, 'POST', $this->eUrl($store), $ok + ['tenant_id' => $other, 'store_id' => $other, 'created_by' => $other, 'currency' => 'BDT', 'id' => $other])
            ->assertCreated()->json('data');
        $this->assertNotSame($other, $row['id']);
        $db = $this->expenseRow($tenant, $row['id']);
        $this->assertSame([$tenant->id, $store->id, 'BDT'], [$db->tenant_id, $db->store_id, $db->currency]);
        $this->assertNotSame($other, $db->created_by);
    }

    public function test_permissions_and_the_profit_tile_gates(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        $e = $this->addExpense($h, $store);
        $this->api($h, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', -10000);

        // Manager has it by default.
        [, $admin] = $this->memberAs($tenant, TenantUser::ROLE_ADMIN);
        $this->api($admin, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', -10000);

        // Staff: 403 on every route.
        [, $staff] = $this->memberAs($tenant, TenantUser::ROLE_STAFF);
        foreach ([
            ['GET', ''], ['POST', ''], ['GET', '/summary'], ['GET', '/export'], ['POST', '/receipts'],
            ['GET', "/{$e['id']}"], ['PATCH', "/{$e['id']}"], ['DELETE', "/{$e['id']}"], ['GET', "/{$e['id']}/receipt"],
        ] as [$method, $suffix]) {
            $this->api($staff, $method, $this->eUrl($store, $suffix), ['amount' => 1])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }

        // A custom role with only expenses.manage: everything works, the profit tile is null (never 403).
        [, $only] = $this->memberWithRole($tenant, $this->customRole($h, 'Cashier', ['expenses.manage']));
        $this->addExpense($only, $store);
        $s = $this->api($only, 'GET', $this->eUrl($store, '/summary'))->assertOk();
        $s->assertJsonPath('data.profit_after_expenses_amount', null)->assertJsonPath('data.delivered_orders_count', 0);
        $this->api($only, 'GET', "/api/v1/stores/{$store->id}/reports/profit")->assertForbidden();

        // reports.view without costs.view → null; with both → the figure.
        [, $noCost] = $this->memberWithRole($tenant, $this->customRole($h, 'Bookkeeper', ['expenses.manage', 'reports.view']));
        $this->api($noCost, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', null);
        [, $full] = $this->memberWithRole($tenant, $this->customRole($h, 'Accountant', ['expenses.manage', 'reports.view', 'costs.view']));
        $this->api($full, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', -20000);

        // Starter owner: the ledger works (no plan gate), the profit tile is null.
        $this->planFor($tenant, Plan::STARTER);
        $this->addExpense($h, $store);
        $this->api($h, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertJsonPath('data.profit_after_expenses_amount', null)
            ->assertJsonPath('data.total_amount', 30000);
    }

    public function test_cross_tenant_and_cross_store_access_is_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->shop(slug: 'alpha');
        [, $tenantB, $storeB, $hB] = $this->shop(slug: 'beta');
        $b = $this->addExpense($hB, $storeB, ['receipt_id' => $this->pdfReceipt($hB, $storeB)]);
        $this->addExpense($hA, $storeA);

        $this->assertTenantIsolation($hA, [
            ['GET', $this->eUrl($storeB)], ['POST', $this->eUrl($storeB), ['amount' => 1, 'category' => 'ads', 'paid_from' => 'cash', 'spent_on' => '2026-11-20']],
            ['GET', $this->eUrl($storeB, '/summary')], ['GET', $this->eUrl($storeB, '/export')],
            ['GET', $this->eUrl($storeB, "/{$b['id']}")], ['PATCH', $this->eUrl($storeB, "/{$b['id']}"), ['amount' => 1]],
            ['DELETE', $this->eUrl($storeB, "/{$b['id']}")], ['GET', $this->eUrl($storeB, "/{$b['id']}/receipt")],
        ]);
        // B's expense id under A's own store: 404 too.
        foreach (['GET' => '', 'PATCH' => '', 'DELETE' => ''] as $method => $_) {
            $this->api($hA, $method, $this->eUrl($storeA, "/{$b['id']}"), ['amount' => 1])->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
        $this->api($hA, 'GET', $this->eUrl($storeA, "/{$b['id']}/receipt"))->assertNotFound();
        // B's receipt can't be attached in A.
        $this->api($hA, 'POST', $this->eUrl($storeA), ['amount' => 1, 'category' => 'ads', 'paid_from' => 'cash', 'spent_on' => '2026-11-20', 'receipt_id' => $b['receipt']['id']])
            ->assertUnprocessable()->assertJsonValidationErrorFor('receipt_id', 'error.details');

        $this->assertSame(1, $this->api($hA, 'GET', $this->eUrl($storeA, '/summary'))->json('data.count'));
        $this->assertStoreIsolation(Expense::class, $tenantA, $storeA, $storeB);
        $this->assertStoreIsolation(ExpenseRecurrence::class, $tenantA, $storeA, $storeB);
        $this->assertSame(10000, $this->expenseRow($tenantB, $b['id'])->amount);
    }

    public function test_month_summary_maths(): void
    {
        [, $tenant, $store, $h] = $this->growthShop();
        // November (current month, today = the 20th).
        $this->addExpense($h, $store, ['amount' => 25000, 'category' => 'salaries', 'spent_on' => '2026-11-01']);
        $this->addExpense($h, $store, ['amount' => 10000, 'category' => 'ads', 'spent_on' => '2026-11-02']);
        $this->addExpense($h, $store, ['amount' => 5000, 'category' => 'packaging', 'spent_on' => '2026-11-20']);
        // October: the 15th is inside the compare span (1–20), the 25th is not.
        $this->addExpense($h, $store, ['amount' => 8000, 'category' => 'ads', 'spent_on' => '2026-10-15']);
        $this->addExpense($h, $store, ['amount' => 40000, 'category' => 'rent_bills', 'spent_on' => '2026-10-25']);
        // Delivered in November (Dhaka): two; one in October; one shipped.
        $this->order($tenant, $store, ['status' => 'delivered', 'placed_at' => '2026-11-01 10:00:00', 'delivered_at' => '2026-11-05 10:00:00', 'total' => 1000]);
        $this->order($tenant, $store, ['status' => 'delivered', 'placed_at' => '2026-11-01 10:00:00', 'delivered_at' => '2026-10-31 19:00:00', 'total' => 1000]); // 01:00 Dhaka on 1 Nov
        $this->order($tenant, $store, ['status' => 'delivered', 'placed_at' => '2026-10-01 10:00:00', 'delivered_at' => '2026-10-31 17:00:00', 'total' => 1000]); // 23:00 Dhaka 31 Oct
        $this->order($tenant, $store, ['status' => 'shipped', 'placed_at' => '2026-11-01 10:00:00', 'total' => 1000]);

        $s = $this->api($h, 'GET', $this->eUrl($store, '/summary'))->assertOk()->assertHeader('Cache-Control', 'no-store, private')->json('data');
        $this->assertSame(['2026-11', '2026-11-01', '2026-11-20', 'BDT', 40000, 3, 10000], [$s['month'], $s['from'], $s['to'], $s['currency'], $s['total_amount'], $s['count'], $s['ads_amount']]);
        $this->assertEquals(0.25, $s['ads_share']);
        $this->assertEquals([
            ['category' => 'salaries', 'amount' => 25000, 'count' => 1, 'share' => 0.625],
            ['category' => 'ads', 'amount' => 10000, 'count' => 1, 'share' => 0.25],
            ['category' => 'packaging', 'amount' => 5000, 'count' => 1, 'share' => 0.125],
        ], $s['by_category']);
        $this->assertSame(['label_month' => '2026-10', 'total_amount' => 8000, 'change_pct' => 400], $s['compare']);
        $this->assertSame([2, 20000], [$s['delivered_orders_count'], $s['cost_per_order_amount']]);
        $this->assertSame(['2026-11', '2026-10'], $s['months']);
        // Profit tile = P&L net profit for the same range (AC 3).
        $pnl = $this->report($h, $store, 'profit', ['from' => '2026-11-01', 'to' => '2026-11-20'])->assertOk();
        $this->assertSame($pnl->json('data.summary.net_profit_amount'), $s['profit_after_expenses_amount']);
        $this->assertSame(2000 - 40000, $s['profit_after_expenses_amount']);

        // A past month compares full month with full month; September has nothing → change null.
        $oct = $this->api($h, 'GET', $this->eUrl($store, '/summary?month=2026-10'))->assertOk()->json('data');
        $this->assertSame(['2026-10-01', '2026-10-31', 48000, 1, null], [$oct['from'], $oct['to'], $oct['total_amount'], $oct['delivered_orders_count'], $oct['compare']['change_pct']]);
        $this->assertSame('2026-09', $oct['compare']['label_month']);
        $this->api($h, 'GET', $this->eUrl($store, '/summary?month=2026-13'))->assertUnprocessable();

        // Empty month: zeros and nulls.
        $sep = $this->api($h, 'GET', $this->eUrl($store, '/summary?month=2026-09'))->assertOk()->json('data');
        $this->assertSame([0, 0, null, [], null], [$sep['total_amount'], $sep['count'], $sep['ads_share'], $sep['by_category'], $sep['cost_per_order_amount']]);
    }

    public function test_compare_span_is_clamped_to_a_shorter_previous_month(): void
    {
        [, , $store, $h] = $this->shop();
        $this->travelTo(CarbonImmutable::parse('2027-03-31 06:00:00', 'UTC'));
        $this->addExpense($h, $store, ['amount' => 1000, 'spent_on' => '2027-02-28']);
        $this->addExpense($h, $store, ['amount' => 3000, 'spent_on' => '2027-03-31']);
        $this->api($h, 'GET', $this->eUrl($store, '/summary'))->assertOk()
            ->assertJsonPath('data.compare', ['label_month' => '2027-02', 'total_amount' => 1000, 'change_pct' => 200]);
    }

    public function test_csv_export_is_formula_safe_scoped_and_audited(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, , $other, $hOther] = $this->shop(slug: 'other');
        $this->addExpense($h, $store, ['amount' => 123456, 'category' => 'ads', 'paid_from' => 'bkash', 'spent_on' => '2026-11-03', 'note' => '=HYPERLINK("http://x")']);
        $this->addExpense($h, $store, ['amount' => 5, 'spent_on' => '2026-11-04', 'note' => '@SUM(1)', 'repeat_monthly' => true, 'receipt_id' => $this->pdfReceipt($h, $store)]);
        $this->addExpense($h, $store, ['spent_on' => '2026-10-04', 'note' => 'October']);
        $this->addExpense($hOther, $other, ['note' => 'Other store']);

        $res = $this->flushHeaders()->withHeaders($h)->get($this->eUrl($store, '/export'))->assertOk();
        $this->assertStringStartsWith('text/csv', (string) $res->headers->get('Content-Type'));
        $this->assertSame("attachment; filename=\"expenses-{$store->slug}-2026-11.csv\"", $res->headers->get('Content-Disposition'));
        $lines = explode("\n", trim((string) $res->getContent()));
        $this->assertSame([
            'date,category,note,paid_from,amount,currency,receipt,repeats',
            "2026-11-04,packaging,'@SUM(1),cash,0.05,BDT,yes,yes",
            "2026-11-03,ads,\"'=HYPERLINK(\"\"http://x\"\")\",bkash,1234.56,BDT,no,no",
        ], $lines);

        $this->assertStringContainsString('October', $this->flushHeaders()->withHeaders($h)->get($this->eUrl($store, '/export?month=2026-10'))->assertOk()->getContent());
        $this->api($h, 'GET', $this->eUrl($store, '/export?month=2027-01'))->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $exported = collect($this->auditRows($tenant))->where('action', 'expense.exported')->values();
        $this->assertSame(['month' => '2026-11', 'count' => 2], $exported[0]['meta']);
    }

    public function test_export_over_5000_rows_is_422(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $rows = [];
        for ($i = 0; $i < 5001; $i++) {
            $rows[] = ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'category' => 'other',
                'paid_from' => 'cash', 'amount' => 1, 'currency' => 'BDT', 'spent_on' => '2026-11-01', 'created_at' => now(), 'updated_at' => now()];
        }
        $this->inTenant($tenant, fn () => collect($rows)->chunk(500)->each(fn ($c) => DB::table('expenses')->insert($c->all())));
        $this->api($h, 'GET', $this->eUrl($store, '/export'))->assertUnprocessable()
            ->assertJsonPath('error.code', 'export_too_large')->assertJsonPath('error.details.limit', 5000);
    }

    public function test_a_write_is_in_the_next_profit_report(): void
    {
        [, , $store, $h] = $this->growthShop();
        $range = ['from' => '2026-11-01', 'to' => '2026-11-20'];
        $this->report($h, $store, 'profit', $range)->assertOk()->assertJsonPath('data.summary.net_profit_amount', 0);

        $e = $this->addExpense($h, $store, ['amount' => 7000, 'category' => 'ads']);
        $this->report($h, $store, 'profit', $range)->assertOk()->assertJsonPath('data.summary.ad_spend_amount', 7000)
            ->assertJsonPath('data.summary.net_profit_amount', -7000);
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$e['id']}"), ['amount' => 9000, 'category' => 'courier'])->assertOk();
        $this->report($h, $store, 'profit', $range)->assertOk()->assertJsonPath('data.summary.ad_spend_amount', 0)
            ->assertJsonPath('data.summary.other_expenses_amount', 9000);
        $this->api($h, 'DELETE', $this->eUrl($store, "/{$e['id']}"))->assertNoContent();
        $this->report($h, $store, 'profit', $range)->assertOk()->assertJsonPath('data.summary.net_profit_amount', 0);
    }

    public function test_a_rolled_back_write_leaves_the_revision_token_unchanged(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->addExpense($h, $store);
        $rev = app(ExpenseRevision::class);
        $before = $this->inTenant($tenant, fn () => $rev->token($store->id));
        $this->assertNotSame('0', $before);
        try {
            DB::transaction(function () use ($tenant, $rev, $store) {
                $this->inTenant($tenant, fn () => $rev->bump($tenant->id, $store->id));
                throw new \RuntimeException('rollback');
            });
        } catch (\RuntimeException) {
        }
        $this->assertSame($before, $this->inTenant($tenant, fn () => $rev->token($store->id)));
    }
}
