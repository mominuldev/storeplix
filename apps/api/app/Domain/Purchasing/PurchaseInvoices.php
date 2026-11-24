<?php

declare(strict_types=1);

namespace App\Domain\Purchasing;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Purchasing\Models\PurchaseReceipt;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Supplier invoice uploads (PHASE-8-8B §3, Q208, S176), modelled exactly on the 8.7 expense receipts: `media` rows with
 * purpose `purchase_invoice` on the PRIVATE disk under the tenant prefix, MIME sniffed from the bytes (the same
 * inspection as ExpenseReceipts: JPEG/PNG/WebP/PDF ≤ 5 MB, extension tricks refused), images re-encoded by ProcessMedia
 * (EXIF/GPS stripped, no variants), never in `/media`. Opened only through a signed 5-minute link (hidden under
 * impersonation, like receipts P87-8).
 */
final class PurchaseInvoices
{
    public const LINK_MINUTES = 5;

    public const UNUSABLE = 'This invoice can’t be used. Upload it again.';

    public function __construct(
        private readonly TenantStorage $storage,
        private readonly ExpenseReceipts $receipts,
    ) {}

    /** @return array{mime: string, width: int, height: int}|string the inspected file, or the 422 message */
    public function inspect(UploadedFile $file): array|string
    {
        return $this->receipts->inspect($file); // identical rules (MediaPurpose::PurchaseInvoice mirrors ExpenseReceipt)
    }

    /** @param array{mime: string, width: int, height: int} $info */
    public function store(UploadedFile $file, array $info, User $user): Media
    {
        $id = strtolower((string) Str::ulid());
        $disk = $this->storage->privateDiskName();
        $path = $this->storage->path($id, 'original.'.MediaPurpose::extensionFor($info['mime']));
        $this->storage->disk($disk)->put($path, (string) file_get_contents((string) $file->getRealPath()));
        $pdf = $info['mime'] === 'application/pdf';

        $media = new Media;
        $media->id = $id;
        $media->forceFill([
            'purpose' => MediaPurpose::PurchaseInvoice->value,
            'disk' => $disk,
            'path' => $path,
            'mime' => $info['mime'],
            'size_bytes' => (int) $file->getSize(),
            'width' => $info['width'],
            'height' => $info['height'],
            'checksum' => (string) hash_file('sha256', (string) $file->getRealPath()),
            'status' => $pdf ? Media::READY : Media::PROCESSING,
            'variants' => [],
            'uploaded_by' => $user->getKey(),
        ])->save();

        if (! $pdf) {
            ProcessMedia::dispatch($media->id);
        }

        return $media->refresh();
    }

    /**
     * An invoice of this tenant (scoped query), purpose `purchase_invoice`, not `failed`, uploaded by a member of this
     * tenant, not attached to another receipt. Locked for the rest of the transaction (S176).
     *
     * @throws ValidationException 422 on `invoice_media_id`
     */
    public function attachable(string $id): Media
    {
        $media = Media::query()->whereKey(strtolower($id))->where('purpose', MediaPurpose::PurchaseInvoice->value)->lockForUpdate()->first();
        $taken = $media !== null && PurchaseReceipt::query()->where('invoice_media_id', $media->id)->exists();
        $member = $media?->uploaded_by !== null && TenantUser::query()->where('tenant_id', $media->tenant_id)->where('user_id', $media->uploaded_by)->exists();

        if ($media === null || $media->status === Media::FAILED || $taken || ! $member) {
            throw ValidationException::withMessages(['invoice_media_id' => [self::UNUSABLE]]);
        }

        return $media;
    }

    /** Signed 5-minute download link; null while processing, failed, or in an impersonation session. */
    public static function link(Media $media): ?string
    {
        $request = request();
        if ($media->status !== Media::READY || ($request->hasSession() && ImpersonationSession::isImpersonating($request))) {
            return null;
        }

        return URL::temporarySignedRoute('purchase-invoices.download', now()->addMinutes(self::LINK_MINUTES), ['media' => $media->id, 'tenant' => $media->tenant_id]);
    }
}
