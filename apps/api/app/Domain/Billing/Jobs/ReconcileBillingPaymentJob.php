<?php

declare(strict_types=1);

namespace App\Domain\Billing\Jobs;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** §4.2: query one billing payment and confirm it; past `expires_at` with no success → cancelled (`expired`). */
class ReconcileBillingPaymentJob implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    public function __construct(public readonly string $paymentId, string $tenantId)
    {
        $this->forTenant($tenantId);
        $this->onQueue('billing');
    }

    public function handle(BillingPaymentService $payments): void
    {
        $payment = BillingPayment::query()->find($this->paymentId);
        if ($payment !== null) {
            $payments->refresh($payment);
        }
    }
}
