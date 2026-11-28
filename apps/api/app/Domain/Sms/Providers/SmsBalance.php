<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

/** A gateway balance in paisa (BDT). */
final readonly class SmsBalance
{
    public function __construct(public int $amountPaisa) {}
}
