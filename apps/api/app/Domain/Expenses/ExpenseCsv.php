<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\DataTransfer\Csv\CsvCell;
use App\Domain\Expenses\Models\Expense;
use App\Domain\Expenses\Models\ExpenseRecurrence;
use Illuminate\Support\Collection;

/**
 * CSV export of a month (PHASE-8-7 P87-14, §8.1): `date, category, note, paid_from, amount, currency, receipt, repeats`;
 * amount in major units with 2 decimals (CSV only); every text cell formula-safe via CsvCell (S148).
 */
final class ExpenseCsv
{
    public const MAX_ROWS = 5000;

    public const HEADER = ['date', 'category', 'note', 'paid_from', 'amount', 'currency', 'receipt', 'repeats'];

    /** @param Collection<int, Expense> $rows */
    public static function render(Collection $rows): string
    {
        $active = ExpenseRecurrence::query()->whereIn('id', $rows->pluck('recurrence_id')->filter()->unique()->values())
            ->where('status', ExpenseRecurrence::ACTIVE)->pluck('id')->flip();
        $out = fopen('php://temp', 'r+');
        fputcsv($out, self::HEADER, ',', '"', '');
        foreach ($rows as $e) {
            fputcsv($out, [
                CsvCell::safe($e->spentOn()),
                CsvCell::safe($e->category),
                CsvCell::safe((string) $e->note),
                CsvCell::safe($e->paid_from),
                self::major((int) $e->amount),
                CsvCell::safe($e->currency),
                $e->receipt_media_id !== null ? 'yes' : 'no',
                $e->recurrence_id !== null && $active->has($e->recurrence_id) ? 'yes' : 'no',
            ], ',', '"', '');
        }
        rewind($out);
        $csv = (string) stream_get_contents($out);
        fclose($out);

        return $csv;
    }

    /** Minor units → "1234.50" (amounts are always positive). */
    public static function major(int $minor): string
    {
        return sprintf('%d.%02d', intdiv($minor, 100), $minor % 100);
    }
}
