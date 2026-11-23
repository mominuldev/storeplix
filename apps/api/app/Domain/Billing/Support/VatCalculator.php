<?php

declare(strict_types=1);

namespace App\Domain\Billing\Support;

/** P7-15 / Q82: prices are VAT-inclusive. tax = floor(total × rate / (10 000 + rate)), subtotal = total − tax (Q52 formula). */
final class VatCalculator
{
    /** @return array{subtotal_amount: int, tax_amount: int, tax_rate_bps: int} */
    public static function split(int $total, ?int $rateBps = null): array
    {
        $rate = max(0, $rateBps ?? (int) config('billing.vat_rate_bps', 1500));
        $tax = $rate === 0 ? 0 : intdiv($total * $rate, 10000 + $rate);

        return ['subtotal_amount' => $total - $tax, 'tax_amount' => $tax, 'tax_rate_bps' => $rate];
    }
}
