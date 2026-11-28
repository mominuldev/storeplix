<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Inbox attachments (PHASE-8-8E P88E-7, §7, S241): JPG / PNG / PDF ≤ 5 MB, MIME sniffed from the bytes (the expense
 * receipt rules with purpose `inbox_attachment`), private disk under the tenant prefix, images re-encoded by
 * ProcessMedia (EXIF stripped, no variants), never a library purpose. Removal everywhere: rows first, objects after
 * commit and only under the current tenant's prefix.
 */
final class InboxAttachments
{
    public const UNSUPPORTED = 'Unsupported file type. Allowed: JPG, PNG, PDF.';

    public const MAX_PER_MESSAGE = 3;

    public function __construct(
        private readonly TenantStorage $storage,
        private readonly ExpenseReceipts $inspector,
    ) {}

    /** @return array{mime: string, width: int, height: int}|string the inspected file, or the 422 message */
    public function inspect(UploadedFile $file): array|string
    {
        if (! $file->isValid()) {
            return self::UNSUPPORTED;
        }
        $result = $this->inspector->inspect($file, MediaPurpose::InboxAttachment);

        return $result === ExpenseReceipts::UNSUPPORTED ? self::UNSUPPORTED : $result;
    }

    /** @param array{mime: string, width: int, height: int} $info */
    public function store(UploadedFile $file, array $info, Store $store, string $byType, ?string $userId = null, ?string $sessionId = null): InboxAttachment
    {
        $media = $this->storeMedia((string) file_get_contents((string) $file->getRealPath()), $info, $userId);

        return $this->row($media, $store->id, $byType, self::filename($file->getClientOriginalName(), $info['mime']), $userId, $sessionId);
    }

    /** P88E-8: the attachment of a saved reply is copied (new media row + object) into each reply that uses it. */
    public function copy(InboxAttachment $source, string $userId): InboxAttachment
    {
        /** @var Media $media */
        $media = Media::query()->whereKey($source->media_id)->firstOrFail();
        $bytes = (string) $this->storage->disk($media->disk)->get($media->path);
        $copy = $this->storeMedia($bytes, ['mime' => $media->mime, 'width' => (int) $media->width, 'height' => (int) $media->height], $userId, $media->status === Media::READY);

        return $this->row($copy, $source->store_id, InboxAttachment::BY_USER, $source->filename, $userId, null);
    }

    /**
     * The attachments named by a send (`attachment_ids`), locked: unattached uploads of this store by the same uploader
     * (member or widget session), not failed. Anything else → 422 on `$field`.
     *
     * @param  list<string>  $ids
     * @return Collection<int, InboxAttachment>
     */
    public function claim(array $ids, string $storeId, ?string $userId, ?string $sessionId = null, string $field = 'attachment_ids'): Collection
    {
        $ids = array_values(array_unique(array_map('strtolower', $ids)));
        if ($ids === []) {
            return new Collection;
        }
        $rows = InboxAttachment::query()->whereIn('id', $ids)->where('store_id', $storeId)
            ->whereNull('message_id')->whereNull('saved_reply_id')
            ->when($userId !== null, fn ($q) => $q->where('uploaded_by_type', InboxAttachment::BY_USER)->where('uploaded_by_user_id', $userId))
            ->when($userId === null && $sessionId !== null, fn ($q) => $q->where('uploaded_by_type', InboxAttachment::BY_SHOPPER)->where('widget_session_id', $sessionId))
            ->when($userId === null && $sessionId === null, fn ($q) => $q->where('uploaded_by_type', '<>', InboxAttachment::BY_USER))
            ->lockForUpdate()->get();
        $failed = Media::query()->whereIn('id', $rows->pluck('media_id')->all())->where('status', Media::FAILED)->exists();
        if ($rows->count() !== count($ids) || $failed) {
            throw ValidationException::withMessages([$field => ['This attachment can’t be used. Upload it again.']]);
        }

        return $rows;
    }

    /**
     * Deletes the attachment rows and their media rows now (inside the caller's transaction), the objects after commit.
     *
     * @param  Collection<int, InboxAttachment>|iterable<InboxAttachment>  $attachments
     */
    public function remove(iterable $attachments): void
    {
        foreach ($attachments as $attachment) {
            $media = Media::query()->whereKey($attachment->media_id)->where('purpose', MediaPurpose::InboxAttachment->value)->first();
            InboxAttachment::query()->whereKey($attachment->id)->delete();
            if ($media !== null && Media::query()->whereKey($media->id)->delete() === 1) {
                DB::afterCommit(function () use ($media) {
                    if ($this->storage->ownsPath($media->path)) {
                        $this->storage->deleteAll($media);
                    }
                });
            }
        }
    }

    /** @param array{mime: string, width: int, height: int} $info */
    private function storeMedia(string $bytes, array $info, ?string $userId, bool $ready = false): Media
    {
        $id = strtolower((string) Str::ulid());
        $disk = $this->storage->privateDiskName();
        $path = $this->storage->path($id, 'original.'.MediaPurpose::extensionFor($info['mime']));
        $this->storage->disk($disk)->put($path, $bytes);
        $pdf = $info['mime'] === 'application/pdf';

        $media = new Media;
        $media->id = $id;
        $media->forceFill([
            'purpose' => MediaPurpose::InboxAttachment->value,
            'disk' => $disk,
            'path' => $path,
            'mime' => $info['mime'],
            'size_bytes' => strlen($bytes),
            'width' => $info['width'],
            'height' => $info['height'],
            'checksum' => hash('sha256', $bytes),
            'status' => $pdf || $ready ? Media::READY : Media::PROCESSING,
            'variants' => [],
            'uploaded_by' => $userId,
        ])->save();

        if (! $pdf && ! $ready) {
            ProcessMedia::dispatch($media->id); // re-encodes on its own (private) disk; variants() = [] here
        }

        return $media->refresh();
    }

    private function row(Media $media, string $storeId, string $byType, string $filename, ?string $userId, ?string $sessionId): InboxAttachment
    {
        $row = new InboxAttachment;
        $row->forceFill([
            'store_id' => $storeId,
            'media_id' => $media->id,
            'uploaded_by_type' => $byType,
            'uploaded_by_user_id' => $byType === InboxAttachment::BY_USER ? $userId : null,
            'widget_session_id' => $sessionId,
            'filename' => $filename,
            'mime' => $media->mime,
            'size_bytes' => (int) $media->size_bytes,
        ])->save();

        return $row;
    }

    public static function filename(?string $name, string $mime): string
    {
        $name = (string) preg_replace('/[\x00-\x1F\x7F\/\\\\]/u', '', basename((string) $name));
        $name = trim($name);
        $ext = MediaPurpose::extensionFor($mime);
        if ($name === '' || $name === '.' || $name === '..') {
            $name = 'attachment.'.$ext;
        }

        return mb_substr($name, 0, 160);
    }

    /** `image` | `pdf` (InboxAttachment.kind). */
    public static function kind(string $mime): string
    {
        return $mime === 'application/pdf' ? 'pdf' : 'image';
    }
}
