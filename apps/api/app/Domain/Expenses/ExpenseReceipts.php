<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\Expenses\Models\Expense;
use App\Domain\Identity\Models\User;
use App\Domain\Media\ImageInspector;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Expense receipts (PHASE-8-7 §5, P87-7): `media` rows with purpose `expense_receipt` on the PRIVATE disk at the normal
 * tenant-prefixed path. Images are re-encoded by ProcessMedia (EXIF/GPS stripped, no variants); PDFs are kept as
 * uploaded after a sanity check. Removal order everywhere (detach, replace, expense delete, prune): the row first,
 * the object after commit, and only for a path under the current tenant's prefix (§9).
 */
final class ExpenseReceipts
{
    public const UNSUPPORTED = 'Unsupported file type. Allowed: JPG, PNG, WebP, PDF.';

    public const TOO_MANY_PIXELS = 'This photo is too large (over 40 megapixels). Take it at a lower resolution or upload a screenshot.';

    private const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

    public function __construct(private readonly TenantStorage $storage) {}

    /**
     * §5.1: MIME from the bytes only. The client name / Content-Type never make a file acceptable, but a claim of the
     * other kind (a JPEG named `.pdf`, a PDF sent as an image) is refused as an extension trick.
     * PHASE-8-9A P89A-16: the same rules check a sender-ID trade licence (`$purpose` SenderIdDocument).
     *
     * @return array{mime: string, width: int, height: int}|string the inspected file, or the 422 message
     */
    public function inspect(UploadedFile $file, MediaPurpose $purpose = MediaPurpose::ExpenseReceipt): array|string
    {
        if ((int) $file->getSize() > $purpose->maxBytes()) {
            return sprintf('The file may not be larger than %d MB.', $purpose->maxBytes() / 1024 / 1024);
        }
        $path = (string) $file->getRealPath();
        $sniffed = (new \finfo(FILEINFO_MIME_TYPE))->file($path);

        if ($sniffed === 'application/pdf') {
            if (! self::looksLikePdf($path) || $this->claimsImage($file)) {
                return self::UNSUPPORTED;
            }

            return ['mime' => 'application/pdf', 'width' => 0, 'height' => 0];
        }

        $info = ImageInspector::inspect($path);
        if ($info === null || ! in_array($info['mime'], $purpose->mimes(), true) || $info['mime'] === 'application/pdf'
            || $info['width'] === 0 || $this->claimsPdf($file)) {
            return self::UNSUPPORTED;
        }
        [$min, $max] = $purpose->sideBounds();
        if ($info['width'] * $info['height'] > MediaPurpose::MAX_PIXELS) {
            return self::TOO_MANY_PIXELS;
        }
        if ($info['width'] < $min || $info['height'] < $min || $info['width'] > $max || $info['height'] > $max) {
            return "Each side must be between {$min} and {$max} px.";
        }

        return $info;
    }

    /** `%PDF-` at byte 0 and `%%EOF` in the last 1 KB (a sanity check; safety comes from how it is served, §5.3). */
    public static function looksLikePdf(string $path): bool
    {
        $size = (int) filesize($path);
        $handle = fopen($path, 'rb');
        if ($handle === false || $size < 10) {
            return false;
        }
        try {
            $head = (string) fread($handle, 5);
            fseek($handle, max(0, $size - 1024));
            $tail = (string) stream_get_contents($handle);
        } finally {
            fclose($handle);
        }

        return $head === '%PDF-' && str_contains($tail, '%%EOF');
    }

    private function claimsPdf(UploadedFile $file): bool
    {
        return strtolower($file->getClientOriginalExtension()) === 'pdf' || strtolower((string) $file->getClientMimeType()) === 'application/pdf';
    }

    private function claimsImage(UploadedFile $file): bool
    {
        return in_array(strtolower($file->getClientOriginalExtension()), self::IMAGE_EXTENSIONS, true)
            || str_starts_with(strtolower((string) $file->getClientMimeType()), 'image/');
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
            'purpose' => MediaPurpose::ExpenseReceipt->value,
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
            ProcessMedia::dispatch($media->id); // re-encodes on its own (private) disk; variants() = [] for receipts
        }

        return $media->refresh();
    }

    /**
     * §5.2: a receipt of this tenant (scoped query), purpose `expense_receipt`, not `failed`, uploaded by a member of
     * this tenant, not attached to another expense. Locked for the rest of the transaction.
     *
     * @throws ValidationException 422 on `receipt_id`
     */
    public function attachable(string $id, ?Expense $current): Media
    {
        $media = Media::query()->whereKey(strtolower($id))->where('purpose', MediaPurpose::ExpenseReceipt->value)->lockForUpdate()->first();
        $taken = $media !== null && Expense::query()->where('receipt_media_id', $media->id)
            ->when($current !== null, fn ($q) => $q->whereKeyNot($current->id))->exists();
        $member = $media?->uploaded_by !== null && TenantUser::query()->where('tenant_id', $media->tenant_id)->where('user_id', $media->uploaded_by)->exists();

        if ($media === null || $media->status === Media::FAILED || $taken || ! $member) {
            throw ValidationException::withMessages(['receipt_id' => ['This receipt can’t be used. Upload it again.']]);
        }

        return $media;
    }

    /** Deletes the receipt row now (inside the caller's transaction) and its object after commit. */
    public function remove(?string $mediaId): void
    {
        if ($mediaId === null) {
            return;
        }
        $media = Media::query()->whereKey($mediaId)->where('purpose', MediaPurpose::ExpenseReceipt->value)->first();
        if ($media === null) {
            return;
        }
        $deleted = Media::query()->whereKey($media->id)->delete();
        if ($deleted === 1) {
            $this->deleteObjectAfterCommit($media);
        }
    }

    public function deleteObjectAfterCommit(Media $media): void
    {
        DB::afterCommit(function () use ($media) {
            if ($this->storage->ownsPath($media->path)) {
                $this->storage->deleteAll($media);
            }
        });
    }
}
