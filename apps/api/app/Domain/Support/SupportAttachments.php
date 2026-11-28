<?php

declare(strict_types=1);

namespace App\Domain\Support;

use App\Domain\Expenses\ExpenseReceipts;
use App\Domain\Inbox\InboxAttachments;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Ticket attachments (PHASE-8-9C P89C-15, S255): JPG / PNG / PDF ≤ 10 MB, MIME sniffed from the bytes (the expense
 * receipt inspector with purpose `support_attachment`), private disk under the CURRENT tenant's prefix, images
 * re-encoded by ProcessMedia (EXIF stripped, no variants), never a library purpose. ≤ 5 per message. Removal: rows
 * first, objects after commit and only under the current tenant's prefix. Inside the tenant context.
 */
final class SupportAttachments
{
    public const UNSUPPORTED = 'Unsupported file type. Allowed: JPG, PNG, PDF up to 10 MB.';

    public const MAX_PER_MESSAGE = 5;

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
        $result = $this->inspector->inspect($file, MediaPurpose::SupportAttachment);

        return $result === ExpenseReceipts::UNSUPPORTED ? self::UNSUPPORTED : $result;
    }

    /** @param array{mime: string, width: int, height: int} $info */
    public function store(UploadedFile $file, array $info, string $byType, string $userId, ?string $ticketId = null): SupportTicketAttachment
    {
        $bytes = (string) file_get_contents((string) $file->getRealPath());
        $id = strtolower((string) Str::ulid());
        $disk = $this->storage->privateDiskName();
        $path = $this->storage->path($id, 'original.'.MediaPurpose::extensionFor($info['mime']));
        $this->storage->disk($disk)->put($path, $bytes);
        $pdf = $info['mime'] === 'application/pdf';

        $media = new Media;
        $media->id = $id;
        $media->forceFill([
            'purpose' => MediaPurpose::SupportAttachment->value,
            'disk' => $disk,
            'path' => $path,
            'mime' => $info['mime'],
            'size_bytes' => strlen($bytes),
            'width' => $info['width'],
            'height' => $info['height'],
            'checksum' => hash('sha256', $bytes),
            'status' => $pdf ? Media::READY : Media::PROCESSING,
            'variants' => [],
            'uploaded_by' => $userId,
        ])->save();
        if (! $pdf) {
            ProcessMedia::dispatch($media->id); // re-encodes on the private disk; variants() = [] for this purpose
        }

        $row = new SupportTicketAttachment;
        $row->forceFill([
            'ticket_id' => $ticketId,
            'media_id' => $media->id,
            'uploaded_by_type' => $byType,
            'uploaded_by_user_id' => $userId,
            'filename' => InboxAttachments::filename($file->getClientOriginalName(), $info['mime']),
            'mime' => $info['mime'],
            'size_bytes' => strlen($bytes),
        ])->save();

        return $row;
    }

    /**
     * The attachments named by a send, locked: unattached uploads by the same uploader (member: no ticket yet or this
     * ticket; staff: uploaded to this ticket), not failed. Anything else → 422 on $field.
     *
     * @param  list<string>  $ids
     * @return Collection<int, SupportTicketAttachment>
     */
    public function claim(array $ids, string $byType, string $userId, ?string $ticketId, string $field = 'attachment_ids'): Collection
    {
        $ids = array_values(array_unique(array_map(fn ($i) => strtolower((string) $i), $ids)));
        if ($ids === []) {
            return new Collection;
        }
        if (count($ids) > self::MAX_PER_MESSAGE) {
            throw ValidationException::withMessages([$field => ['Attach at most '.self::MAX_PER_MESSAGE.' files.']]);
        }
        $rows = SupportTicketAttachment::query()->whereIn('id', $ids)->whereNull('message_id')
            ->where('uploaded_by_type', $byType)->where('uploaded_by_user_id', $userId)
            ->where(fn ($q) => $byType === SupportTicketAttachment::BY_STAFF
                ? $q->where('ticket_id', $ticketId)
                : $q->whereNull('ticket_id')->when($ticketId !== null, fn ($w) => $w->orWhere('ticket_id', $ticketId)))
            ->lockForUpdate()->get();
        $failed = Media::query()->whereIn('id', $rows->pluck('media_id')->all())->where('status', Media::FAILED)->exists();
        if ($rows->count() !== count($ids) || $failed) {
            throw ValidationException::withMessages([$field => ['This attachment can’t be used. Upload it again.']]);
        }

        return $rows;
    }

    /** @param Collection<int, SupportTicketAttachment> $files */
    public function attach(Collection $files, SupportTicketMessage $message): void
    {
        if ($files->isNotEmpty()) {
            SupportTicketAttachment::query()->whereIn('id', $files->pluck('id')->all())
                ->update(['ticket_id' => $message->ticket_id, 'message_id' => $message->id]);
        }
    }

    /**
     * Deletes attachment rows and their media rows now (inside the caller's transaction), the objects after commit.
     *
     * @param  iterable<SupportTicketAttachment>  $attachments
     */
    public function remove(iterable $attachments): void
    {
        foreach ($attachments as $attachment) {
            $media = Media::query()->whereKey($attachment->media_id)->where('purpose', MediaPurpose::SupportAttachment->value)->first();
            SupportTicketAttachment::query()->whereKey($attachment->id)->delete();
            if ($media !== null && Media::query()->whereKey($media->id)->delete() === 1) {
                DB::afterCommit(function () use ($media) {
                    if ($this->storage->ownsPath($media->path)) {
                        $this->storage->deleteAll($media);
                    }
                });
            }
        }
    }

    public static function kind(string $mime): string
    {
        return $mime === 'application/pdf' ? 'pdf' : 'image';
    }
}
