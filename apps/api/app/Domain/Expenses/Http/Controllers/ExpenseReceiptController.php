<?php

declare(strict_types=1);

namespace App\Domain\Expenses\Http\Controllers;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Expenses\Http\Requests\UploadReceiptRequest;
use App\Domain\Expenses\Http\Resources\ExpensePresenter;
use App\Domain\Expenses\Models\Expense;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Receipts (PHASE-8-7 §5): upload (private disk), the signed 5-minute view link and the public signed download.
 */
class ExpenseReceiptController
{
    public const LINK_MINUTES = 5;

    public function __construct(
        private readonly ExpenseReceipts $receipts,
        private readonly TenantContext $context,
    ) {}

    /** POST /stores/{store}/expenses/receipts → 201 ExpenseReceipt. */
    public function store(UploadReceiptRequest $request, Store $store): JsonResponse
    {
        $media = $this->receipts->store($request->file('file'), (array) $request->inspected, $request->user());

        return new JsonResponse(['data' => ExpensePresenter::receipt($media)], 201);
    }

    /**
     * GET /stores/{store}/expenses/{expense}/receipt → {url, mime, size_bytes, expires_at}. P87-8: an impersonation
     * session gets 403 `impersonation_receipt_hidden` (a GET, so the read-only middleware lets it through).
     */
    public function link(Request $request, Store $store, string $expense): JsonResponse
    {
        if ($request->hasSession() && ImpersonationSession::isImpersonating($request)) {
            throw new ApiException(403, 'impersonation_receipt_hidden', 'Receipts are hidden in an impersonation session.');
        }
        $row = ExpenseController::find($store, $expense);
        /** @var Media|null $media */
        $media = $row->receipt_media_id === null ? null : Media::query()->whereKey($row->receipt_media_id)->first();
        if ($media === null || $media->status === Media::FAILED) {
            throw new ApiException(404, 'receipt_not_found', 'This expense has no receipt.');
        }
        if ($media->status !== Media::READY) {
            throw new ApiException(409, 'receipt_processing', 'The receipt is still being processed. Try again in a moment.');
        }
        $expires = now()->addMinutes(self::LINK_MINUTES);

        return new JsonResponse(['data' => [
            'url' => URL::temporarySignedRoute('expense-receipts.download', $expires, ['media' => $media->id, 'tenant' => $media->tenant_id]),
            'mime' => $media->mime,
            'size_bytes' => (int) $media->size_bytes,
            'expires_at' => $expires->toIso8601ZuluString(),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    /**
     * GET /expense-receipts/{media}/download (signed, 5 minutes, no session). Tenant from the signed parameters; only a
     * ready receipt on the private disk, under the tenant prefix and attached to an expense is served (S144, S146).
     * A `%PDF-` polyglot is still only an attachment with nosniff + CSP sandbox (S143).
     */
    public function download(Request $request, string $media, TenantStorage $storage): StreamedResponse
    {
        return $this->context->run((string) $request->query('tenant'), function () use ($media, $storage) {
            /** @var Media|null $row */
            $row = Media::query()->whereKey(strtolower($media))->first();
            $expense = $row === null ? null : Expense::query()->where('receipt_media_id', $row->id)->first();
            if ($row === null || $expense === null || $row->purpose !== MediaPurpose::ExpenseReceipt->value || $row->status !== Media::READY
                || $row->disk !== $storage->privateDiskName() || ! $storage->ownsPath($row->path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $pdf = $row->mime === 'application/pdf';
            $name = 'receipt-'.$expense->spentOn().'.'.MediaPurpose::extensionFor($row->mime);

            return $storage->privateDisk()->response($row->path, $name, [
                'Content-Type' => $row->mime,
                'X-Content-Type-Options' => 'nosniff',
                'Content-Security-Policy' => "sandbox; default-src 'none'",
                'Cache-Control' => 'private, no-store',
                'Referrer-Policy' => 'no-referrer',
            ], $pdf ? 'attachment' : 'inline');
        });
    }
}
