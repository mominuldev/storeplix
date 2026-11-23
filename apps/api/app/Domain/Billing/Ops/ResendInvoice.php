<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\BillingNotifier;
use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\PlanChangeService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-8-1 P8-15: e-mails the invoice to the owner again with the Phase 7 templates (open → reminder, paid →
 * payment received). Audit `billing.invoice_resent`. The 3/hour per invoice limit is the caller's.
 */
final class ResendInvoice
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly BillingNotifier $notifier,
        private readonly PlanChangeService $plans,
    ) {}

    /** @throws ApiException 409 invoice_not_open for a void invoice */
    public function handle(string $tenantId, string $invoiceId, OpsActor $actor): BillingInvoice
    {
        return $this->context->run($tenantId, function () use ($invoiceId, $actor) {
            $invoice = BillingInvoice::query()->with('plan')->findOrFail($invoiceId);
            if ($invoice->status === BillingInvoice::VOID) {
                throw new ApiException(409, 'invoice_not_open', "{$invoice->number} is void.");
            }
            $paid = $invoice->status === BillingInvoice::PAID;
            $date = $paid ? ($invoice->period_end ?? PlanChangeService::periodEndsAt($this->plans->current())) : $invoice->due_at;
            $this->notifier->owner($paid ? BillingMail::PAYMENT_RECEIVED : BillingMail::REMINDER, [
                'number' => $invoice->number, 'amount' => Money::bdt($invoice->total_amount), 'plan' => $invoice->plan->name,
                'date' => BillingNotifier::date($date),
            ]);
            $actor->audit('billing.invoice_resent', $invoice, ['number' => $invoice->number, 'reason' => $actor->reason]);

            return $invoice;
        });
    }
}
