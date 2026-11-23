<?php

declare(strict_types=1);

namespace App\Domain\Billing\Ops;

use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Support\BillingLock;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-7 §4.4 `billing:void` / PHASE-8-1 P8-15: open → void (`void_reason: manual`) inside the invoice's tenant.
 * Audit `billing.invoice_voided` (InvoiceService); for staff it carries the platform actor and `meta.reason` = the
 * staff reason (`meta.void_reason: manual`).
 */
final class VoidInvoice
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly InvoiceService $invoices,
    ) {}

    /** @throws ApiException 409 invoice_not_open */
    public function handle(string $tenantId, string $invoiceId, OpsActor $actor): BillingInvoice
    {
        return $this->context->run($tenantId, function () use ($tenantId, $invoiceId, $actor) {
            $invoice = BillingInvoice::query()->findOrFail($invoiceId);
            $done = BillingLock::run($tenantId, fn () => DB::transaction(fn () => $actor->isStaff()
                ? $this->invoices->void($invoice, BillingInvoice::VOID_MANUAL, false, $actor->staff, ['reason' => $actor->reason, 'void_reason' => BillingInvoice::VOID_MANUAL])
                : $this->invoices->void($invoice, BillingInvoice::VOID_MANUAL)));
            if (! $done) {
                throw new ApiException(409, 'invoice_not_open', "{$invoice->number} is not open.");
            }

            return $invoice->refresh();
        });
    }
}
