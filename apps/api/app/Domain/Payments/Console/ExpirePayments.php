<?php

declare(strict_types=1);

namespace App\Domain\Payments\Console;

use App\Domain\Payments\Jobs\RunPaymentSweep;

class ExpirePayments extends PaymentSweepCommand
{
    protected $signature = 'payments:expire {--sync : run the per-tenant jobs inline}';

    protected $description = 'Cancel unpaid online orders whose 30-minute hold expired (query the provider first)';

    protected function kind(): string
    {
        return RunPaymentSweep::EXPIRE;
    }
}
