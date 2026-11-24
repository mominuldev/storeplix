<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

/**
 * PHASE-8-7 §3 (P87-1, Q167): six fixed, code-defined categories in UI order. `ads` is the Profit & loss "Ad spend"
 * line; the other five are "Other expenses". Labels are UI copy (WEB); the API returns keys only.
 */
enum ExpenseCategory: string
{
    case Ads = 'ads';
    case Packaging = 'packaging';
    case Salaries = 'salaries';
    case RentBills = 'rent_bills';
    case Courier = 'courier';
    case Other = 'other';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
