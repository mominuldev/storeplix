<?php

declare(strict_types=1);

namespace App\Domain\Billing;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Documents\Drivers\DocumentDriver;
use App\Domain\Documents\Drivers\DocumentRenderFailed;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\DB;

/**
 * P7-15: invoice PDFs through the 5b-4 renderer (ADR 0014; A4, English). Generated on demand; cached on the private
 * disk under the tenant prefix (`tenants/{tenant}/billing/{invoice}.{ext}`) once the invoice is paid or void.
 * With DOCUMENTS_DRIVER=html (local/CI) the "PDF" is the rendered HTML.
 */
final class BillingInvoicePdf
{
    public function __construct(
        private readonly DocumentDriver $driver,
        private readonly TenantStorage $storage,
    ) {}

    /** @return array{bytes: string, mime: string, extension: string} */
    public function get(BillingInvoice $invoice): array
    {
        $final = $invoice->status !== BillingInvoice::OPEN;
        $disk = $this->storage->privateDisk();
        if ($final && $invoice->pdf_path !== null && $this->storage->ownsPath($invoice->pdf_path) && $disk->exists($invoice->pdf_path)) {
            $ext = pathinfo($invoice->pdf_path, PATHINFO_EXTENSION);

            return ['bytes' => (string) $disk->get($invoice->pdf_path), 'extension' => $ext, 'mime' => $ext === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8'];
        }

        try {
            $file = $this->driver->render($this->html($invoice, fonts: config('documents.driver') === 'gotenberg'), 'invoice_a4');
        } catch (DocumentRenderFailed) {
            throw new ApiException(502, 'provider_unavailable', 'The PDF service is not available. Try again in a moment.');
        }
        if ($final) {
            $path = 'tenants/'.$invoice->tenant_id.'/billing/'.$invoice->id.'.'.$file['extension'];
            $disk->put($path, $file['bytes']);
            DB::table('billing_invoices')->where('id', $invoice->id)->where('tenant_id', $invoice->tenant_id)->update(['pdf_path' => $path]);
        }

        return ['bytes' => $file['bytes'], 'mime' => $file['mime'], 'extension' => $file['extension']];
    }

    public function html(BillingInvoice $invoice, bool $fonts = false): string
    {
        $tz = (string) (Store::query()->value('timezone') ?: 'Asia/Dhaka');
        $date = fn ($at) => $at?->copy()->timezone($tz)->format('j M Y');
        $paidWith = $invoice->paid_payment_id !== null ? BillingPayment::query()->whereKey($invoice->paid_payment_id)->value('provider') : null;

        return view('documents.billing_invoice', [
            'fonts' => $fonts,
            'number' => $invoice->number,
            'status' => $invoice->status,
            'issued' => $date($invoice->issued_at),
            'due' => $date($invoice->due_at),
            'paid' => $date($invoice->paid_at),
            'seller' => (string) config('billing.seller'),
            'bin' => config('billing.vat_bin'),
            'billTo' => $invoice->bill_to,
            'period' => $invoice->period_start !== null && $invoice->period_end !== null ? $date($invoice->period_start).' – '.$date($invoice->period_end) : null,
            'lines' => array_map(fn (array $l) => ['description' => (string) $l['description'], 'quantity' => (int) ($l['quantity'] ?? 1),
                'amount' => Money::bdt((int) $l['amount'])], $invoice->lines),
            'subtotal' => Money::bdt($invoice->subtotal_amount),
            'tax' => Money::bdt($invoice->tax_amount),
            'rate' => rtrim(rtrim(number_format($invoice->tax_rate_bps / 100, 2), '0'), '.').' %',
            'total' => Money::bdt($invoice->total_amount),
            'paidWith' => match ($paidWith) {
                'bkash' => 'bKash', 'sslcommerz' => 'SSLCommerz', 'manual' => 'bank transfer', default => null
            },
        ])->render();
    }
}
