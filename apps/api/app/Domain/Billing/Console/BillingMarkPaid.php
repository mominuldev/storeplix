<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Tenancy\Support\AuditLogger;

class BillingMarkPaid extends BillingOpsCommand
{
    protected $signature = 'billing:mark-paid {invoice : invoice number or id} {--reference= : bank reference} {--reason=} {--force}';

    protected $description = 'Record a manual (bank transfer / support) payment of an open or void invoice and apply it';

    public function handle(BillingPaymentService $payments, AuditLogger $audit): int
    {
        if (! $this->guard()) {
            return self::FAILURE;
        }
        $located = $this->locateInvoice((string) $this->argument('invoice'));
        if ($located === null) {
            $this->error('Invoice not found.');

            return self::FAILURE;
        }
        [$tenantId, $invoiceId] = $located;

        return $this->inTenant($tenantId, function () use ($invoiceId, $payments, $audit) {
            $invoice = BillingInvoice::query()->findOrFail($invoiceId);
            if ($invoice->status === BillingInvoice::PAID) {
                $this->error("{$invoice->number} is already paid.");

                return self::FAILURE;
            }
            $payment = new BillingPayment;
            $payment->forceFill([
                'invoice_id' => $invoice->id, 'provider' => BillingPayment::MANUAL, 'status' => BillingPayment::PENDING,
                'amount' => $invoice->total_amount, 'currency' => 'BDT', 'expires_at' => now()->addHour(),
                'reference' => mb_substr((string) ($this->option('reference') ?? ''), 0, 120) ?: null,
            ])->save();
            $audit->log('billing.manual_payment', $payment, ['invoice' => $invoice->number, 'reference' => $payment->reference,
                'reason' => (string) $this->option('reason')], system: true);
            $payments->confirm($payment, new Verification(Verification::SUCCEEDED, $invoice->total_amount, 'BDT', $payment->id,
                'MANUAL-'.strtoupper(substr($payment->id, -12)), null, ['manual' => true]));
            $this->info("{$invoice->number} marked paid ({$payment->refresh()->status}).");

            return self::SUCCESS;
        });
    }
}
