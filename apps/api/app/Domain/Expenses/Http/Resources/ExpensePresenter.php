<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Resources;

use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use App\Domain\Media\Models\Media;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Database\Eloquent\Collection as EloquentCollection;
use Illuminate\Support\Collection;

/** Expense and ExpenseReceipt payloads (PHASE-8-7 §8.2, openapi 1.15.0). A receipt never carries a URL (§5.4). */
final class ExpensePresenter
{
    /** @param Collection<int, Expense> $rows @return list<array<string, mixed>> */
    public static function many(Collection $rows): array
    {
        $rows = (new EloquentCollection($rows->all()))->loadMissing(['receipt', 'createdBy', 'recurrence']);

        return $rows->map(fn (Expense $e) => self::expense($e))->values()->all();
    }

    /** @return array<string, mixed> */
    public static function expense(Expense $e): array
    {
        $e->loadMissing(['receipt', 'createdBy', 'recurrence']);
        /** @var Media|null $receipt */
        $receipt = $e->receipt;
        /** @var ExpenseRecurrence|null $recurrence */
        $recurrence = $e->recurrence;

        return [
            'id' => $e->id,
            'category' => $e->category,
            'paid_from' => $e->paid_from,
            'amount' => (int) $e->amount,
            'currency' => $e->currency,
            'spent_on' => $e->spentOn(),
            'note' => $e->note,
            'receipt' => $receipt === null ? null : [
                'id' => $receipt->id, 'mime' => $receipt->mime, 'size_bytes' => (int) $receipt->size_bytes, 'status' => $receipt->status,
            ],
            'repeat_monthly' => $recurrence?->isActive() ?? false,
            'recurrence_id' => $e->recurrence_id,
            'created_by' => UserRef::of($e->createdBy),
            'created_at' => UserRef::iso($e->created_at),
            'updated_at' => UserRef::iso($e->updated_at),
        ];
    }

    /** @return array{id: string, mime: string, size_bytes: int, status: string, created_at: string|null} */
    public static function receipt(Media $m): array
    {
        return ['id' => $m->id, 'mime' => $m->mime, 'size_bytes' => (int) $m->size_bytes, 'status' => $m->status, 'created_at' => UserRef::iso($m->created_at)];
    }
}
