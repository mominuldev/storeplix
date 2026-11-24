<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Ledger writes (PHASE-8-7 §6.1). One transaction each; every write audits (P87-4) and bumps the store's
 * `expenses_rev` after commit (P87-12). Input arrives validated (StoreExpenseRequest / UpdateExpenseRequest) and is
 * mapped field by field — tenant_id, store_id, currency and created_by never come from the body (S147).
 */
final class ExpenseService
{
    public const DUPLICATE_DAY = 'This repeating expense already has an entry on that day.';

    /** Fields whose change is audited as `changes: {field: [old, new]}` (§4). */
    private const TRACKED = ['amount', 'category', 'spent_on', 'paid_from'];

    public function __construct(
        private readonly AuditLogger $audit,
        private readonly ExpenseReceipts $receipts,
        private readonly ExpenseRevision $revision,
    ) {}

    public static function today(Store $store): string
    {
        return CarbonImmutable::now($store->timezone ?: 'Asia/Dhaka')->format('Y-m-d');
    }

    /** @param array<string, mixed> $input */
    public function create(Store $store, array $input, User $user): Expense
    {
        return $this->mapUniqueViolations(fn () => DB::transaction(function () use ($store, $input, $user) {
            // §6.4: the store row lock (FOR SHARE) serialises a first expense against a currency change.
            $currency = (string) DB::table('stores')->where('tenant_id', $store->tenant_id)->where('id', $store->id)->sharedLock()->value('currency');
            if (isset($input['currency']) && strtoupper((string) $input['currency']) !== $currency) {
                throw ValidationException::withMessages(['currency' => ["The currency must be your shop's currency ({$currency})."]]);
            }

            $expense = new Expense;
            $expense->store_id = $store->id;
            $expense->category = $input['category'];
            $expense->paid_from = $input['paid_from'];
            $expense->amount = (int) $input['amount'];
            $expense->currency = $currency;
            $expense->spent_on = $input['spent_on'];
            $expense->note = $input['note'] ?? null;
            $expense->created_by = $user->id;
            $expense->updated_by = $user->id;
            if (($input['receipt_id'] ?? null) !== null) {
                $expense->receipt_media_id = $this->receipts->attachable((string) $input['receipt_id'], null)->id;
            }
            $recurrence = ($input['repeat_monthly'] ?? false) === true ? $this->startRecurrence($store, $expense->spent_on, $user) : null;
            $expense->recurrence_id = $recurrence?->id;
            $expense->save();

            $this->audit->log('expense.created', $expense, self::meta($expense));
            if ($recurrence !== null) {
                $this->audit->log('expense.recurrence_started', $expense, self::recurrenceMeta($recurrence));
            }
            $this->revision->bump($store->tenant_id, $store->id);

            return $expense;
        }));
    }

    /** @param array<string, mixed> $input partial */
    public function update(Store $store, Expense $expense, array $input, User $user): Expense
    {
        return $this->mapUniqueViolations(fn () => DB::transaction(function () use ($store, $expense, $input, $user) {
            /** @var Expense $row */
            $row = Expense::query()->where('store_id', $store->id)->whereKey($expense->id)->lockForUpdate()->firstOrFail();
            if (isset($input['currency']) && strtoupper((string) $input['currency']) !== $row->currency) {
                throw ValidationException::withMessages(['currency' => ["The currency must be your shop's currency ({$row->currency})."]]);
            }
            $before = ['amount' => $row->amount, 'category' => $row->category, 'spent_on' => $row->spentOn(), 'paid_from' => $row->paid_from];

            foreach (['category', 'paid_from', 'spent_on'] as $field) {
                if (array_key_exists($field, $input)) {
                    $row->{$field} = $input[$field];
                }
            }
            if (array_key_exists('amount', $input)) {
                $row->amount = (int) $input['amount'];
            }
            if (array_key_exists('note', $input)) {
                $row->note = $input['note'];
            }

            // §6.1: a date that collides with another occurrence of the same series → 422, checked first.
            if ($row->recurrence_id !== null && $row->spentOn() !== $before['spent_on']
                && Expense::query()->where('recurrence_id', $row->recurrence_id)->where('spent_on', $row->spentOn())->whereKeyNot($row->id)->exists()) {
                throw ValidationException::withMessages(['spent_on' => [self::DUPLICATE_DAY]]);
            }

            $oldReceipt = null;
            if (array_key_exists('receipt_id', $input)) {
                $new = $input['receipt_id'] === null ? null : strtolower((string) $input['receipt_id']);
                if ($new !== $row->receipt_media_id) {
                    $oldReceipt = $row->receipt_media_id;
                    $row->receipt_media_id = $new === null ? null : $this->receipts->attachable($new, $row)->id;
                }
            }

            $started = $stopped = null;
            if (array_key_exists('repeat_monthly', $input)) {
                $current = $row->recurrence_id !== null ? ExpenseRecurrence::query()->whereKey($row->recurrence_id)->lockForUpdate()->first() : null;
                $active = $current?->isActive() ?? false;
                if ($input['repeat_monthly'] === true && ! $active) {
                    $started = $this->startRecurrence($store, $row->spentOn(), $user);
                    $row->recurrence_id = $started->id;
                } elseif ($input['repeat_monthly'] === false && $active) {
                    $stopped = $this->stop($current);
                }
            }

            $changes = [];
            $after = ['amount' => $row->amount, 'category' => $row->category, 'spent_on' => $row->spentOn(), 'paid_from' => $row->paid_from];
            foreach (self::TRACKED as $field) {
                if ($before[$field] !== $after[$field]) {
                    $changes[$field] = [$before[$field], $after[$field]];
                }
            }

            if (! $row->isDirty() && $stopped === null) {
                return $row;
            }
            $row->updated_by = $user->id;
            $row->save();
            $this->receipts->remove($oldReceipt); // detached / replaced: row now, object after commit (§5.2)

            $this->audit->log('expense.updated', $row, self::meta($row) + ($changes !== [] ? ['changes' => $changes] : []));
            if ($started !== null) {
                $this->audit->log('expense.recurrence_started', $row, self::recurrenceMeta($started));
            }
            if ($stopped !== null) {
                $this->audit->log('expense.recurrence_stopped', $row, ['recurrence_id' => $stopped->id]);
            }
            $this->revision->bump($store->tenant_id, $store->id);

            return $row;
        }));
    }

    public function delete(Store $store, Expense $expense): void
    {
        DB::transaction(function () use ($store, $expense) {
            /** @var Expense $row */
            $row = Expense::query()->where('store_id', $store->id)->whereKey($expense->id)->lockForUpdate()->firstOrFail();
            $stopped = null;
            if ($row->recurrence_id !== null) {
                $recurrence = ExpenseRecurrence::query()->whereKey($row->recurrence_id)->lockForUpdate()->first();
                $others = Expense::query()->where('recurrence_id', $row->recurrence_id)->whereKeyNot($row->id)->exists();
                if ($recurrence !== null && $recurrence->isActive() && ! $others) {
                    $stopped = $this->stop($recurrence); // §6.1: the last row of an active series stops it
                }
            }
            $snapshot = self::meta($row) + [
                'paid_from' => $row->paid_from, 'note' => $row->note, 'had_receipt' => $row->receipt_media_id !== null,
                'recurrence_id' => $row->recurrence_id,
            ];
            $receipt = $row->receipt_media_id;
            $row->delete();
            $this->receipts->remove($receipt); // P87-13: row first, object after commit

            $this->audit->log('expense.deleted', $row, $snapshot);
            if ($stopped !== null) {
                $this->audit->log('expense.recurrence_stopped', $row, ['recurrence_id' => $stopped->id]);
            }
            $this->revision->bump($store->tenant_id, $store->id);
        });
    }

    private function startRecurrence(Store $store, string $spentOn, User $user): ExpenseRecurrence
    {
        $day = MonthlySchedule::dayOf($spentOn);
        $recurrence = new ExpenseRecurrence;
        $recurrence->store_id = $store->id;
        $recurrence->day_of_month = $day;
        $recurrence->next_on = MonthlySchedule::firstAfter(self::today($store), $day);
        $recurrence->status = ExpenseRecurrence::ACTIVE;
        $recurrence->created_by = $user->id;
        $recurrence->save();

        return $recurrence;
    }

    private function stop(ExpenseRecurrence $recurrence): ExpenseRecurrence
    {
        $recurrence->status = ExpenseRecurrence::STOPPED;
        $recurrence->stopped_at = now();
        $recurrence->save();

        return $recurrence;
    }

    /** @return array{category: string, amount: int, currency: string, spent_on: string} */
    public static function meta(Expense $expense): array
    {
        return ['category' => $expense->category, 'amount' => (int) $expense->amount, 'currency' => $expense->currency, 'spent_on' => $expense->spentOn()];
    }

    /** @return array<string, mixed> */
    private static function recurrenceMeta(ExpenseRecurrence $recurrence): array
    {
        return ['recurrence_id' => $recurrence->id, 'day_of_month' => $recurrence->day_of_month, 'next_on' => $recurrence->nextOn()];
    }

    /**
     * A concurrent attach of the same receipt or a racing occurrence date hits a unique index: answer the same 422 as
     * the explicit checks, never a 500 (§6.1, §5.2).
     *
     * @template T
     *
     * @param  callable(): T  $fn
     * @return T
     */
    private function mapUniqueViolations(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (UniqueConstraintViolationException $e) {
            if (str_contains($e->getMessage(), 'receipt_media_id')) {
                throw ValidationException::withMessages(['receipt_id' => ['This receipt can’t be used. Upload it again.']]);
            }
            if (str_contains($e->getMessage(), 'recurrence_id') || str_contains($e->getMessage(), 'expenses_recurrence_spent_on_unique')) {
                throw ValidationException::withMessages(['spent_on' => [self::DUPLICATE_DAY]]);
            }
            throw $e;
        }
    }
}
