<?php

declare(strict_types=1);

namespace App\Domain\Purchasing\Http\Controllers;

use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Purchasing\Http\Requests\UploadInvoiceRequest;
use App\Domain\Purchasing\Models\PurchaseReceipt;
use App\Domain\Purchasing\PurchaseInvoices;
use App\Domain\Purchasing\PurchasingInsights;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

/** PHASE-8-8B §7 reorder suggestions, §8.1 supplier invoice upload, and the signed invoice download (like 8.7 receipts). */
class PurchasingController
{
    public function __construct(
        private readonly PurchaseInvoices $invoices,
        private readonly TenantContext $context,
    ) {}

    public function reorderSuggestions(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => PurchasingInsights::reorderSuggestions($store)], 200, ['Cache-Control' => 'private, no-store']);
    }

    /** POST /stores/{store}/purchasing/invoices → 201 PurchaseInvoice (private disk, never in /media, S176). */
    public function uploadInvoice(UploadInvoiceRequest $request, Store $store): JsonResponse
    {
        $media = $this->invoices->store($request->file('file'), (array) $request->inspected, $request->user());

        return new JsonResponse(['data' => [
            'id' => $media->id,
            'mime' => $media->mime,
            'size_bytes' => (int) $media->size_bytes,
            'status' => $media->status,
            'created_at' => $media->created_at?->toIso8601ZuluString(),
        ]], 201);
    }

    /**
     * GET /purchase-invoices/{media}/download (signed, 5 minutes, no session). Tenant from the signed parameters; only a
     * ready invoice on the private disk, under the tenant prefix and attached to a receipt is served (S176).
     */
    public function downloadInvoice(Request $request, string $media, TenantStorage $storage): StreamedResponse
    {
        return $this->context->run((string) $request->query('tenant'), function () use ($media, $storage) {
            /** @var Media|null $row */
            $row = Media::query()->whereKey(strtolower($media))->first();
            $receipt = $row === null ? null : PurchaseReceipt::query()->where('invoice_media_id', $row->id)->first();
            if ($row === null || $receipt === null || $row->purpose !== MediaPurpose::PurchaseInvoice->value || $row->status !== Media::READY
                || $row->disk !== $storage->privateDiskName() || ! $storage->ownsPath($row->path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $name = 'supplier-invoice-'.$receipt->received_at->format('Y-m-d').'.'.MediaPurpose::extensionFor($row->mime);

            return $storage->privateDisk()->response($row->path, $name, [
                'Content-Type' => $row->mime,
                'X-Content-Type-Options' => 'nosniff',
                'Content-Security-Policy' => "sandbox; default-src 'none'",
                'Cache-Control' => 'private, no-store',
                'Referrer-Policy' => 'no-referrer',
            ], $row->mime === 'application/pdf' ? 'attachment' : 'inline');
        });
    }
}
