<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Ops\MarkInvoicePaid;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Shared\Http\ApiException;

/** Thin caller of the shared Action (PHASE-8-1 P8-7). */
class BillingMarkPaid extends BillingOpsCommand
{
    protected $signature = 'billing:mark-paid {invoice : invoice number or id} {--reference= : bank reference} {--reason=} {--force}';

    protected $description = 'Record a manual (bank transfer / support) payment of an open or void invoice and apply it';

    public function handle(MarkInvoicePaid $action): int
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

        try {
            $invoice = $action->handle($tenantId, $invoiceId, $this->option('reference'), OpsActor::system((string) $this->option('reason')));
        } catch (ApiException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
        $this->info("{$invoice->number} marked paid ({$this->paymentStatus($tenantId, $invoice)}).");

        return self::SUCCESS;
    }

    private function paymentStatus(string $tenantId, BillingInvoice $invoice): string
    {
        return (string) $this->inTenant($tenantId, fn () => $invoice->payments()->where('provider', 'manual')->latest()->value('status'));
    }
}
