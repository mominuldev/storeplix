<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\InvoiceService;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Support\BillingLock;
use Illuminate\Support\Facades\DB;

class BillingVoid extends BillingOpsCommand
{
    protected $signature = 'billing:void {invoice : invoice number or id} {--reason=} {--force}';

    protected $description = 'Void an open invoice (void_reason manual)';

    public function handle(InvoiceService $invoices): int
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

        return $this->inTenant($tenantId, function () use ($tenantId, $invoiceId, $invoices) {
            $invoice = BillingInvoice::query()->findOrFail($invoiceId);
            $done = BillingLock::run($tenantId, fn () => DB::transaction(fn () => $invoices->void($invoice, BillingInvoice::VOID_MANUAL)));
            $done ? $this->info("{$invoice->number} voided.") : $this->error("{$invoice->number} is not open.");

            return $done ? self::SUCCESS : self::FAILURE;
        });
    }
}
