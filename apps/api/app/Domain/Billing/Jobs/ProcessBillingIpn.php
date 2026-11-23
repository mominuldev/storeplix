<?php

declare(strict_types=1);

namespace App\Domain\Billing\Jobs;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * P7-12 / B23: a verified platform SSLCommerz IPN is only a TRIGGER: the Validation API (val_id) decides through
 * BillingPaymentService::handleReturn. Idempotent: a payment that already succeeded is left alone.
 */
class ProcessBillingIpn implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [30, 120];

    public function __construct(public readonly string $paymentId, public readonly ?string $valId, string $tenantId)
    {
        $this->forTenant($tenantId);
        $this->onQueue('billing');
    }

    public function handle(BillingPaymentService $payments): void
    {
        $payment = BillingPayment::query()->find($this->paymentId);
        if ($payment === null || $payment->provider !== BillingPayment::SSLCOMMERZ || $payment->status === BillingPayment::SUCCEEDED) {
            return;
        }
        $payments->handleReturn($payment, $this->valId !== null ? ['val_id' => $this->valId] : []);
    }
}
