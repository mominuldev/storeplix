<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Expenses\ExpenseService;
use App\Domain\Expenses\Jobs\GenerateRecurringExpenses;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-7 P87-9, §6.2, S149: "Repeat every month" — start, generate, copy-latest, stop, clamping, catch-up, idempotency. */
#[Group('expenses')]
class ExpenseRecurrenceTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpExpenses();
    }

    private function at(string $utc): void
    {
        $this->travelTo(CarbonImmutable::parse($utc, 'UTC'));
    }

    public function test_start_generate_copy_latest_and_stop(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $first = $this->addExpense($h, $store, ['amount' => 50000, 'category' => 'rent_bills', 'paid_from' => 'bank', 'spent_on' => '2026-11-05',
            'note' => 'Shop rent', 'repeat_monthly' => true, 'receipt_id' => $this->pdfReceipt($h, $store)]);
        $this->assertTrue($first['repeat_monthly']);
        $series = $this->recurrenceRow($tenant, $first['recurrence_id']);
        $this->assertSame([5, '2026-12-05', 'active'], [$series->day_of_month, $series->nextOn(), $series->status]);

        $this->repeat(); // nothing due (no catch-up for the start month)
        $this->assertCount(1, $this->expensesOf($tenant));

        $this->at('2026-12-04 17:59:00'); // 23:59 Dhaka on the 4th
        $this->repeat();
        $this->assertCount(1, $this->expensesOf($tenant));
        $this->at('2026-12-04 18:30:00'); // 00:30 Dhaka on the 5th
        $this->repeat();
        $this->repeat();
        $rows = $this->expensesOf($tenant);
        $this->assertCount(2, $rows);
        $dec = $rows[1];
        $this->assertSame(['2026-12-05', 'rent_bills', 'bank', 50000, 'Shop rent', null, null, $first['recurrence_id']],
            [$dec->spentOn(), $dec->category, $dec->paid_from, $dec->amount, $dec->note, $dec->receipt_media_id, $dec->created_by, $dec->recurrence_id]);
        $this->assertSame('2027-01-05', $this->recurrenceRow($tenant, $first['recurrence_id'])->nextOn());
        $shown = $this->api($h, 'GET', $this->eUrl($store, "/{$dec->id}"))->assertOk()->json('data');
        $this->assertSame([true, null], [$shown['repeat_monthly'], $shown['created_by']]);
        $repeated = collect($this->auditRows($tenant))->where('action', 'expense.repeated')->values();
        $this->assertCount(1, $repeated);
        $this->assertSame('system', $repeated[0]['actor_type']);

        // Editing the latest occurrence carries forward.
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$dec->id}"), ['amount' => 55000])->assertOk();
        $this->at('2027-01-05 03:00:00');
        $this->repeat();
        $this->assertSame([50000, 55000, 55000], $this->expensesOf($tenant)->pluck('amount')->all());

        // Turning it off on any occurrence stops the series; past rows stay.
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$first['id']}"), ['repeat_monthly' => false])->assertOk()->assertJsonPath('data.repeat_monthly', false);
        $this->assertSame('stopped', $this->recurrenceRow($tenant, $first['recurrence_id'])->status);
        $this->at('2027-03-06 03:00:00');
        $this->repeat();
        $this->assertCount(3, $this->expensesOf($tenant));
        $this->assertContains('expense.recurrence_started', array_column($this->auditRows($tenant), 'action'));
        $this->assertContains('expense.recurrence_stopped', array_column($this->auditRows($tenant), 'action'));

        // Turning it on again starts a new series from that row's day.
        $again = $this->api($h, 'PATCH', $this->eUrl($store, "/{$dec->id}"), ['repeat_monthly' => true])->assertOk()->json('data');
        $this->assertNotSame($first['recurrence_id'], $again['recurrence_id']);
        $this->assertSame('2027-04-05', $this->recurrenceRow($tenant, $again['recurrence_id'])->nextOn());
    }

    public function test_day_31_clamps_and_outage_catch_up(): void
    {
        $this->at('2026-10-31 06:00:00');
        [, $tenant, $store, $h] = $this->shop();
        $e = $this->addExpense($h, $store, ['spent_on' => '2026-10-31', 'repeat_monthly' => true]);
        $this->assertSame('2026-11-30', $this->recurrenceRow($tenant, $e['recurrence_id'])->nextOn());

        $this->at('2027-03-31 06:00:00'); // five months of outage
        $this->repeat();
        $this->assertSame(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'],
            $this->expensesOf($tenant)->map->spentOn()->all());
        $this->assertSame('2027-04-30', $this->recurrenceRow($tenant, $e['recurrence_id'])->nextOn());
    }

    public function test_a_store_ahead_of_utc_generates_on_its_own_date(): void
    {
        [, $tenantD, $storeD, $hD] = $this->shop(slug: 'dhaka');
        [, $tenantN, $storeN, $hN] = $this->shop(slug: 'newyork');
        $this->setTimezone($tenantN, $storeN, 'America/New_York');
        $this->addExpense($hD, $storeD, ['spent_on' => '2026-11-05', 'repeat_monthly' => true]);
        $this->addExpense($hN, $storeN, ['spent_on' => '2026-11-05', 'repeat_monthly' => true]);

        $this->at('2026-12-04 19:00:00'); // Dhaka: 5 Dec 01:00; New York: 4 Dec 14:00
        $this->repeat();
        $this->assertCount(2, $this->expensesOf($tenantD));
        $this->assertCount(1, $this->expensesOf($tenantN));
        $this->at('2026-12-05 06:00:00');
        $this->repeat();
        $this->assertCount(2, $this->expensesOf($tenantN));
        $this->assertCount(2, $this->expensesOf($tenantD));
    }

    public function test_idempotent_under_retries_and_racing_workers(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $e = $this->addExpense($h, $store, ['spent_on' => '2026-11-05', 'repeat_monthly' => true]);
        $this->at('2026-12-05 06:00:00');
        $job = fn () => $this->inTenant($tenant, fn () => dispatch_sync(new GenerateRecurringExpenses($store->id)));
        $job();
        $job(); // a retried job
        // A second worker that read the old next_on: the unique (recurrence_id, spent_on) keeps one row.
        $this->inTenant($tenant, fn () => DB::table('expense_recurrences')->where('id', $e['recurrence_id'])->update(['next_on' => '2026-12-05']));
        $job();
        $this->assertSame(['2026-11-05', '2026-12-05'], $this->expensesOf($tenant)->map->spentOn()->all());
        $this->assertSame('2027-01-05', $this->recurrenceRow($tenant, $e['recurrence_id'])->nextOn());
        $this->assertCount(1, collect($this->auditRows($tenant))->where('action', 'expense.repeated'));
    }

    public function test_deleting_the_last_row_stops_the_series_and_date_collisions_are_422(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $only = $this->addExpense($h, $store, ['spent_on' => '2026-11-05', 'repeat_monthly' => true]);
        $this->api($h, 'DELETE', $this->eUrl($store, "/{$only['id']}"))->assertNoContent();
        $this->assertSame(ExpenseRecurrence::STOPPED, $this->recurrenceRow($tenant, $only['recurrence_id'])->status);

        $a = $this->addExpense($h, $store, ['spent_on' => '2026-10-20', 'repeat_monthly' => true]);
        $this->at('2026-12-20 06:00:00');
        $this->repeat(); // started on 20 Nov (today) with day 20 → the first date after today is 20 Dec
        $rows = $this->expensesOf($tenant);
        $this->assertSame(['2026-10-20', '2026-12-20'], $rows->map->spentOn()->all());
        $this->api($h, 'PATCH', $this->eUrl($store, "/{$rows[1]->id}"), ['spent_on' => '2026-10-20'])->assertUnprocessable()
            ->assertJsonPath('error.details.spent_on.0', ExpenseService::DUPLICATE_DAY);
        // Deleting one of two keeps the series active.
        $this->api($h, 'DELETE', $this->eUrl($store, "/{$rows[1]->id}"))->assertNoContent();
        $this->assertSame(ExpenseRecurrence::ACTIVE, $this->recurrenceRow($tenant, $a['recurrence_id'])->status);
    }
}
