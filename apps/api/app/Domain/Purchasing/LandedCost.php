<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

/**
 * PHASE-8-8B §5.4 / P88B-5 / P88B-6: the cost maths, pure and integer-only.
 *
 * Landed cost: the PO's net charges (transport − supplier discount) are spread over the lines by line value
 * (unit cost × ordered ÷ subtotal); the integer remainder goes to the largest line (first by position on a tie). When
 * every unit cost is 0 (subtotal 0) the charges are spread by ordered quantity instead. Landed unit cost = unit cost +
 * share ÷ ordered quantity, rounded half up, never below 0.
 *
 * Weighted average: new = round_half_up((max(on_hand_before, 0) × old + qty × landed) ÷ (max(on_hand_before, 0) + qty));
 * the landed unit cost itself when the old cost is null or nothing was on hand.
 */
final class LandedCost
{
    /**
     * @param  list<array{key: string, unit_cost: int, quantity: int}>  $lines  in position order
     * @return array<string, int> key → landed unit cost
     */
    public static function unitCosts(array $lines, int $shipping, int $discount): array
    {
        if ($lines === []) {
            return [];
        }
        $net = $shipping - $discount;
        $subtotal = 0;
        foreach ($lines as $line) {
            $subtotal += $line['unit_cost'] * $line['quantity'];
        }
        $weight = fn (array $l) => $subtotal > 0 ? $l['unit_cost'] * $l['quantity'] : $l['quantity'];
        $total = $subtotal > 0 ? $subtotal : array_sum(array_column($lines, 'quantity'));

        $shares = [];
        $largest = null;
        $allocated = 0;
        foreach ($lines as $line) {
            $share = $total > 0 ? intdiv($net * $weight($line), $total) : 0; // truncates toward zero
            $shares[$line['key']] = $share;
            $allocated += $share;
            if ($largest === null || $weight($line) > $weight($largest)) {
                $largest = $line;
            }
        }
        $shares[$largest['key']] += $net - $allocated;

        $out = [];
        foreach ($lines as $line) {
            $numerator = $line['unit_cost'] * $line['quantity'] + $shares[$line['key']];
            $out[$line['key']] = $numerator <= 0 ? 0 : self::divRoundHalfUp($numerator, $line['quantity']);
        }

        return $out;
    }

    public static function weightedAverage(?int $oldCost, int $onHandBefore, int $quantity, int $landedUnitCost): int
    {
        $before = max($onHandBefore, 0);
        if ($oldCost === null || $before === 0 || $quantity <= 0) {
            return $quantity <= 0 && $oldCost !== null ? $oldCost : $landedUnitCost;
        }

        return self::divRoundHalfUp($before * $oldCost + $quantity * $landedUnitCost, $before + $quantity);
    }

    /** round_half_up(n ÷ d) for n ≥ 0, d > 0. */
    public static function divRoundHalfUp(int $numerator, int $denominator): int
    {
        return intdiv(2 * $numerator + $denominator, 2 * $denominator);
    }
}
