<?php

declare(strict_types=1);

namespace App\Domain\Pos;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use Illuminate\Validation\ValidationException;

/**
 * Till money maths (PHASE-8-8D §6, P88D-9, P88D-15), pure and unit-tested. Every amount is integer minor units of the
 * store currency; the till never converts and change is never a payment.
 */
final class PosMoney
{
    /** @return list<int> denominations (minor units, largest first) the count tables use for $currency; [] = one amount field */
    public static function denominations(string $currency): array
    {
        /** @var array<string, list<int>> $all */
        $all = config('pos.denominations', []);

        return array_values(array_map('intval', $all[strtoupper($currency)] ?? []));
    }

    /**
     * Σ denomination × count. Keys must be this currency's denominations (as strings of minor units), counts 0–10,000;
     * else 422 validation_failed on "{$field}.{key}".
     *
     * @param  array<array-key, mixed>  $counts
     */
    public static function countsTotal(array $counts, string $currency, string $field = 'counts'): int
    {
        $allowed = self::denominations($currency);
        if ($allowed === []) {
            throw ValidationException::withMessages([$field => ['Enter one amount for this currency.']]);
        }
        $max = (int) config('pos.max_count', 10000);
        $total = 0;
        $errors = [];
        foreach ($counts as $key => $count) {
            $denomination = is_int($key) || ctype_digit((string) $key) ? (int) $key : -1;
            if (! in_array($denomination, $allowed, true)) {
                $errors["{$field}.{$key}"] = ['Unknown note or coin.'];

                continue;
            }
            if (! is_int($count) || $count < 0 || $count > $max) {
                $errors["{$field}.{$key}"] = ["Enter a count from 0 to {$max}."];

                continue;
            }
            $total += $denomination * $count;
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return $total;
    }

    /**
     * Normalised counts as stored (keys = denominations as strings, largest first, zero counts kept as sent).
     *
     * @param  array<array-key, int>  $counts
     * @return array<string, int>
     */
    public static function normaliseCounts(array $counts): array
    {
        $out = [];
        foreach ($counts as $key => $count) {
            $out[(string) (int) $key] = (int) $count;
        }
        uksort($out, fn (string $a, string $b) => (int) $b <=> (int) $a);

        return $out;
    }

    /**
     * Payment parts of a sale (P88D-9, S201): Σ parts = total exactly (422 `pos_payment_mismatch`); at most one cash
     * part; a cash part needs `tendered_cash_amount` ≥ the cash part (422 `cash_tendered_short`); change = tendered −
     * cash. Without cash, tendered is ignored (null) and change is 0.
     *
     * @param  list<array{method: string, amount: int}>  $payments
     * @return array{cash_amount: int, tendered_cash_amount: int|null, change_amount: int}
     */
    public static function settle(int $total, array $payments, ?int $tendered): array
    {
        $paid = 0;
        $cash = null;
        foreach ($payments as $i => $p) {
            $paid += (int) $p['amount'];
            if ($p['method'] === 'cash') {
                if ($cash !== null) {
                    throw ValidationException::withMessages(["payments.{$i}.method" => ['Take cash in one part only.']]);
                }
                $cash = (int) $p['amount'];
            }
        }
        if ($paid !== $total) {
            $message = 'The payments add up to '.Money::bdt($paid).' but the sale is '.Money::bdt($total).'.';
            throw new ApiException(422, 'pos_payment_mismatch', $message, ['total_amount' => $total, 'paid_amount' => $paid]);
        }
        if ($cash === null) {
            return ['cash_amount' => 0, 'tendered_cash_amount' => null, 'change_amount' => 0];
        }
        if ($tendered === null || $tendered < $cash) {
            $message = 'Cash received is less than '.Money::bdt($cash).'.';
            throw new ApiException(422, 'cash_tendered_short', $message, ['tendered_cash_amount' => [$message]]);
        }

        return ['cash_amount' => $cash, 'tendered_cash_amount' => $tendered, 'change_amount' => $tendered - $cash];
    }

    /** §6.2: expected cash in drawer = opening + cash charges − cash refunds of the session. */
    public static function expectedCash(int $opening, int $cashCharges, int $cashRefunds): int
    {
        return $opening + $cashCharges - $cashRefunds;
    }

    /**
     * Close maths (P88D-15, S201): variance = counted − expected (negative = short); left ≤ counted; banked = counted −
     * left; |variance| > tolerance needs a note (422 `close_note_required`).
     *
     * @return array{variance_amount: int, banked_amount: int}
     */
    public static function close(int $counted, int $expected, int $left, ?string $note, int $tolerance): array
    {
        if ($left < 0 || $left > $counted) {
            throw ValidationException::withMessages(['left_in_drawer_amount' => ['Leave at most what you counted ('.Money::bdt($counted).').']]);
        }
        $variance = $counted - $expected;
        if (abs($variance) > $tolerance && trim((string) $note) === '') {
            throw new ApiException(422, 'close_note_required', 'The drawer is '.($variance < 0 ? 'short' : 'over').' by '.Money::bdt(abs($variance)).'. Add a note to close.', [
                'variance_amount' => $variance, 'tolerance_amount' => $tolerance,
            ]);
        }

        return ['variance_amount' => $variance, 'banked_amount' => $counted - $left];
    }

    /** P5B-56 / P88D-8: included VAT = floor(total × rate / (10 000 + rate)). */
    public static function includedVat(int $total, int $rateBps): int
    {
        return $rateBps <= 0 || $total <= 0 ? 0 : intdiv($total * $rateBps, 10000 + $rateBps);
    }
}
