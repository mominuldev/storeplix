<?php

declare(strict_types=1);

namespace App\Domain\Billing\Jobs;

use App\Domain\Billing\BillingInvoicePdf;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** §4.3: renders and caches the PDF of a paid / void invoice (queue `documents`). A renderer outage retries. */
class RenderBillingInvoicePdf implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [60, 300];

    public function __construct(public readonly string $invoiceId)
    {
        $this->onQueue('documents');
    }

    public function handle(BillingInvoicePdf $pdf): void
    {
        $invoice = BillingInvoice::query()->find($this->invoiceId);
        if ($invoice === null || $invoice->status === BillingInvoice::OPEN || $invoice->pdf_path !== null) {
            return;
        }
        try {
            $pdf->get($invoice);
        } catch (ApiException $e) {
            $this->release(300);
        }
    }
}
