<?php

declare(strict_types=1);

namespace App\Domain\Billing\Console;

use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Billing\Ops\VoidInvoice;
use App\Domain\Shared\Http\ApiException;

/** Thin caller of the shared Action (PHASE-8-1 P8-7). */
class BillingVoid extends BillingOpsCommand
{
    protected $signature = 'billing:void {invoice : invoice number or id} {--reason=} {--force}';

    protected $description = 'Void an open invoice (void_reason manual)';

    public function handle(VoidInvoice $action): int
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
            $invoice = $action->handle($tenantId, $invoiceId, OpsActor::system((string) $this->option('reason')));
        } catch (ApiException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }
        $this->info("{$invoice->number} voided.");

        return self::SUCCESS;
    }
}
