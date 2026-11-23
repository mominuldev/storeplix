<?php

declare(strict_types=1);

namespace App\Domain\Billing\Support;

use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * P7-15 / B26: global gapless invoice numbers `SP-{YYYY}-{NNNNNN}`, one counter row per year in `platform_counters`
 * (the only writer of that table). Must run inside the issuing transaction: the row stays locked until it commits, so
 * a rolled-back issue gives its number back.
 */
final class InvoiceNumberAllocator
{
    public static function next(?int $year = null): string
    {
        $year ??= (int) now()->format('Y');
        $key = "billing_invoice:{$year}";

        for ($attempt = 0; $attempt < 3; $attempt++) {
            $row = DB::table('platform_counters')->where('key', $key)->lockForUpdate()->first();
            if ($row !== null) {
                $value = (int) $row->value + 1;
                DB::table('platform_counters')->where('key', $key)->update(['value' => $value, 'updated_at' => now()]);

                return self::format($year, $value);
            }
            try {
                // Savepoint: a concurrent first insert of the year must not abort the caller's transaction.
                DB::transaction(fn () => DB::table('platform_counters')->insert(['key' => $key, 'value' => 1, 'updated_at' => now()]));

                return self::format($year, 1);
            } catch (QueryException $e) {
                if (! str_contains(strtolower($e->getMessage()), 'unique') && ! str_contains($e->getMessage(), '23505')) {
                    throw $e;
                }
            }
        }

        throw new \RuntimeException('Could not allocate an invoice number.');
    }

    public static function format(int $year, int $value): string
    {
        return sprintf('SP-%04d-%06d', $year, $value);
    }
}
