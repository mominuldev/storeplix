<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\BillingPaymentService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Payments\Gateways\Verification;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-7 §4.4 `billing:mark-paid` / PHASE-8-1 P8-15: records a `manual` billing payment for an open (or void: paid
 * late, P7-14) invoice and applies it like a verified provider payment. Runs inside the invoice's tenant on the app
 * connection (P8-7). Audit `billing.manual_payment` (reference + reason).
 */
final class MarkInvoicePaid
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly BillingPaymentService $payments,
    ) {}

    /**
     * @param  string|null  $idempotencyKey  admin API (S61 style): the key is stored on the payment row; the same key
     *                                       for the same invoice returns the invoice, for another invoice → 409
     *
     * @throws ApiException 409 invoice_not_open (already paid), 409 idempotency_key_mismatch
     */
    public function handle(string $tenantId, string $invoiceId, ?string $reference, OpsActor $actor, ?string $idempotencyKey = null): BillingInvoice
    {
        return $this->context->run($tenantId, function () use ($invoiceId, $reference, $actor, $idempotencyKey) {
            $invoice = BillingInvoice::query()->findOrFail($invoiceId);
            if ($idempotencyKey !== null) {
                $previous = BillingPayment::query()->where('idempotency_key', $idempotencyKey)->first(['id', 'invoice_id']);
                if ($previous !== null) {
                    if ($previous->invoice_id !== $invoice->id) {
                        throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
                    }

                    return $invoice->refresh();
                }
            }
            if ($invoice->status === BillingInvoice::PAID) {
                throw new ApiException(409, 'invoice_not_open', "{$invoice->number} is already paid.");
            }

            $payment = new BillingPayment;
            $payment->forceFill([
                'invoice_id' => $invoice->id, 'provider' => BillingPayment::MANUAL, 'status' => BillingPayment::PENDING,
                'amount' => $invoice->total_amount, 'currency' => 'BDT', 'expires_at' => now()->addHour(),
                'reference' => mb_substr((string) ($reference ?? ''), 0, 120) ?: null,
                'idempotency_key' => $idempotencyKey,
                'initiated_by' => $actor->staff?->id,
            ])->save();
            $actor->audit('billing.manual_payment', $payment, ['invoice' => $invoice->number, 'reference' => $payment->reference,
                'reason' => $actor->reason]);
            $this->payments->confirm($payment, new Verification(Verification::SUCCEEDED, $invoice->total_amount, 'BDT', $payment->id,
                'MANUAL-'.strtoupper(substr($payment->id, -12)), null, ['manual' => true]), $actor->staff);

            return $invoice->refresh();
        });
    }
}
