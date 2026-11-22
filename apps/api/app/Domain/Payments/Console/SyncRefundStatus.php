<?php

declare(strict_types=1);

namespace App\Domain\Payments\Console;

use App\Domain\Payments\Jobs\RunPaymentSweep;

class SyncRefundStatus extends PaymentSweepCommand
{
    protected $signature = 'payments:refund-status {--sync : run the per-tenant jobs inline}';

    protected $description = 'Re-check gateway refunds the provider reported as processing';

    protected function kind(): string
    {
        return RunPaymentSweep::REFUND_STATUS;
    }
}
