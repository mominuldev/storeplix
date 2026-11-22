<?php

declare(strict_types=1);

namespace App\Domain\Payments\Console;

use App\Domain\Payments\Jobs\RunPaymentSweep;

class ExpirePaymentLinks extends PaymentSweepCommand
{
    protected $signature = 'payment-links:expire {--sync : run the per-tenant jobs inline}';

    protected $description = 'Expire payment links; cancel unpaid orders when cancel_if_unpaid';

    protected function kind(): string
    {
        return RunPaymentSweep::LINKS;
    }
}
