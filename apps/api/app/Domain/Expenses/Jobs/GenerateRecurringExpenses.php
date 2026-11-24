<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Jobs;

use App\Domain\Expenses\ExpenseRevision;
use App\Domain\Expenses\ExpenseService;
use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Expenses\MonthlySchedule;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-7 §6.2: creates the due occurrences of one store's active "Repeat every month" series. Per series, in a
 * transaction holding `FOR UPDATE` on the recurrence: while `next_on ≤ today` (store tz, at most 12 iterations) copy the
 * series' latest remaining occurrence (category, paid from, amount, note; never the receipt) onto `next_on` with
 * `ON CONFLICT DO NOTHING` on `(recurrence_id, spent_on)`, then advance `next_on` one month (clamped). No occurrence
 * left → the series stops. Two workers, a retried job or a second command run produce one row per date (S149).
 */
class GenerateRecurringExpenses implements ShouldQueue
{
    use Queueable, TenantAware;

    public const MAX_ITERATIONS = 12;

    public int $tries = 3;

    public int $timeout = 60;

    public function __construct(public readonly string $storeId)
    {
        $this->onQueue('default');
    }

    public function handle(AuditLogger $audit, ExpenseRevision $revision): void
    {
        /** @var Store|null $store */
        $store = Store::query()->whereKey($this->storeId)->first(); // tenant-scoped
        if ($store === null) {
            return;
        }
        $today = ExpenseService::today($store);
        $ids = ExpenseRecurrence::query()->where('store_id', $store->id)->where('status', ExpenseRecurrence::ACTIVE)
            ->where('next_on', '<=', $today)->orderBy('next_on')->pluck('id');

        $created = 0;
        foreach ($ids as $id) {
            $created += $this->generate($store, (string) $id, $today, $audit);
        }
        if ($created > 0) {
            $revision->bump($store->tenant_id, $store->id);
        }
    }

    /** @return int occurrences created for this series */
    private function generate(Store $store, string $recurrenceId, string $today, AuditLogger $audit): int
    {
        return DB::transaction(function () use ($store, $recurrenceId, $today, $audit) {
            /** @var ExpenseRecurrence|null $recurrence */
            $recurrence = ExpenseRecurrence::query()->where('store_id', $store->id)->whereKey($recurrenceId)->lockForUpdate()->first();
            if ($recurrence === null || ! $recurrence->isActive()) {
                return 0;
            }

            $created = 0;
            for ($i = 0; $i < self::MAX_ITERATIONS && $recurrence->nextOn() <= $today; $i++) {
                /** @var Expense|null $latest */
                $latest = Expense::query()->where('recurrence_id', $recurrence->id)
                    ->orderByDesc('spent_on')->orderByDesc('id')->first();
                if ($latest === null) {
                    $recurrence->status = ExpenseRecurrence::STOPPED;
                    $recurrence->stopped_at = now();
                    break;
                }

                $date = $recurrence->nextOn();
                $id = strtolower((string) Str::ulid());
                $now = now();
                $inserted = DB::table('expenses')->insertOrIgnore([
                    'id' => $id,
                    'tenant_id' => $store->tenant_id,
                    'store_id' => $store->id,
                    'category' => $latest->category,
                    'paid_from' => $latest->paid_from,
                    'amount' => (int) $latest->amount,
                    'currency' => $latest->currency,
                    'spent_on' => $date,
                    'note' => $latest->note,
                    'receipt_media_id' => null,
                    'recurrence_id' => $recurrence->id,
                    'created_by' => null,
                    'updated_by' => null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                if ($inserted === 1) {
                    /** @var Expense $row */
                    $row = Expense::query()->whereKey($id)->firstOrFail();
                    $audit->log('expense.repeated', $row, ExpenseService::meta($row) + ['recurrence_id' => $recurrence->id], system: true);
                    $created++;
                }
                $recurrence->next_on = MonthlySchedule::advance($date, (int) $recurrence->day_of_month);
            }
            $recurrence->save();

            return $created;
        });
    }
}
