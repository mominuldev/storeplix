<?php

declare(strict_types=1);

namespace App\Domain\Payments\Console;

use App\Domain\Payments\Jobs\RunPaymentSweep;

class ReconcilePayments extends PaymentSweepCommand
{
    protected $signature = 'payments:reconcile {--sync : run the per-tenant jobs inline}';

    protected $description = 'Verify pending online charges older than 2 minutes with the provider';

    protected function kind(): string
    {
        return RunPaymentSweep::RECONCILE;
    }
}
