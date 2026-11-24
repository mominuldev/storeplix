<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

/** PHASE-8-7 §3 (Q175): "Paid from" — a label only, no account balances. UI order. */
enum PaidFrom: string
{
    case Cash = 'cash';
    case Bank = 'bank';
    case Card = 'card';
    case Bkash = 'bkash';
    case Nagad = 'nagad';
    case Other = 'other';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
