<?php

declare(strict_types=1);

namespace App\Domain\Sms\SenderIds;

use App\Domain\Billing\BillingNotifier;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Mail\SmsMail;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Throwable;

/**
 * Masked sender ID requests (PHASE-8-9A §8, P89A-13 – P89A-17, S215, S216). Merchant side: request (with a private
 * trade licence), cancel. Staff side (called by the admin controller inside the request's tenant context): approve,
 * reject, revoke. The approved row of a store is the caller ID its SMS use (SmsSender, cache flushed on every change).
 *
 * Global uniqueness (pending + approved, case-insensitive, across shops) is enforced by the unique index
 * `sms_sender_ids_taken`: a merchant can't see other tenants' rows under RLS, so a violation is mapped to 409
 * `sender_id_taken` (also covers the race of two shops asking at the same moment).
 */
final class SenderIdService
{
    public function __construct(
        private readonly TenantStorage $storage,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * POST /stores/{store}/sms/sender-ids. Order of checks (§8.2): validation (Form Request) → reserved → unchanged →
     * pending exists → taken → store the media → insert.
     *
     * @param  array{sender_id: string, business_name: string, uses: list<string>, note: ?string}  $input
     * @param  array{mime: string, width: int, height: int}  $inspected
     */
    public function request(Store $store, array $input, UploadedFile $document, array $inspected, User $user): SmsSenderId
    {
        $senderId = trim($input['sender_id']);
        if (self::isReserved($senderId)) {
            throw new ApiException(422, 'sender_id_reserved', 'This sender ID is reserved. Choose another name.', ['sender_id' => ['This sender ID is reserved. Choose another name.']]);
        }
        $active = SmsSenderId::query()->where('store_id', $store->id)->where('status', SmsSenderId::APPROVED)->value('sender_id');
        if (is_string($active) && strcasecmp($active, $senderId) === 0) {
            throw new ApiException(422, 'sender_id_unchanged', 'This is already your sender ID.', ['sender_id' => ['This is already your sender ID.']]);
        }
        $this->assertNoPending($store);

        $mediaId = strtolower((string) Str::ulid());
        $disk = $this->storage->privateDiskName();
        $path = $this->storage->path($mediaId, 'original.'.MediaPurpose::extensionFor($inspected['mime']));
        $this->storage->disk($disk)->put($path, (string) file_get_contents((string) $document->getRealPath()));
        $pdf = $inspected['mime'] === 'application/pdf';

        try {
            $row = DB::transaction(function () use ($store, $input, $senderId, $document, $inspected, $user, $mediaId, $disk, $path, $pdf) {
                $media = new Media;
                $media->id = $mediaId;
                $media->forceFill([
                    'purpose' => MediaPurpose::SenderIdDocument->value,
                    'disk' => $disk,
                    'path' => $path,
                    'mime' => $inspected['mime'],
                    'size_bytes' => (int) $document->getSize(),
                    'width' => $inspected['width'],
                    'height' => $inspected['height'],
                    'checksum' => (string) hash_file('sha256', (string) $document->getRealPath()),
                    'alt' => self::filename($document),
                    'status' => $pdf ? Media::READY : Media::PROCESSING,
                    'variants' => [],
                    'uploaded_by' => $user->getKey(),
                ])->save();

                $now = now();
                $row = new SmsSenderId;
                $row->forceFill([
                    'store_id' => $store->id,
                    'sender_id' => $senderId,
                    'business_name' => trim($input['business_name']),
                    'uses' => array_values(array_intersect(SmsSenderId::USES, $input['uses'])),
                    'note' => ($note = trim((string) ($input['note'] ?? ''))) === '' ? null : $note,
                    'status' => SmsSenderId::PENDING,
                    'document_media_id' => $mediaId,
                    'rights_confirmed_at' => $now,
                    'requested_by' => $user->getKey(),
                    'requested_at' => $now,
                ])->save();

                $this->audit->log('sender_id.requested', $row, [
                    'sender_id' => $senderId, 'uses' => $row->uses, 'document_media_id' => $mediaId, 'rights_confirmed' => true,
                ]);

                return $row;
            });
        } catch (UniqueConstraintViolationException $e) {
            $this->storage->disk($disk)->deleteDirectory('tenants/'.$store->tenant_id.'/media/'.$mediaId);
            if (self::isPendingIndex($e)) {
                $this->assertNoPending($store);
            }
            throw new ApiException(409, 'sender_id_taken', 'Another shop already uses or asked for this sender ID. Choose another name.');
        } catch (Throwable $e) {
            $this->storage->disk($disk)->deleteDirectory('tenants/'.$store->tenant_id.'/media/'.$mediaId);
            throw $e;
        }

        if (! $pdf) {
            ProcessMedia::dispatch($mediaId)->afterCommit(); // re-encodes on the private disk (EXIF stripped, no variants)
        }
        $this->notify(SmsMail::SENDER_ID_REQUESTED, ['sender_id' => $senderId]);
        $ops = config('billing.ops_email');
        if (is_string($ops) && $ops !== '') {
            Mail::to($ops)->send(new SmsMail(SmsMail::SENDER_ID_REQUESTED_OPS, $store->name, ['sender_id' => $senderId]));
        }

        return $row->refresh()->load(['document', 'requestedBy']);
    }

    /** POST …/sender-ids/{id}/cancel: pending → cancelled, else 409. */
    public function cancel(SmsSenderId $row): SmsSenderId
    {
        $moved = DB::transaction(function () use ($row) {
            $locked = SmsSenderId::query()->where('store_id', $row->store_id)->whereKey($row->id)->lockForUpdate()->firstOrFail();
            if ($locked->status !== SmsSenderId::PENDING) {
                return null;
            }
            $locked->forceFill(['status' => SmsSenderId::CANCELLED, 'ended_at' => now()])->save();
            $this->audit->log('sender_id.cancelled', $locked, ['sender_id' => $locked->sender_id]);

            return $locked;
        });

        return ($moved ?? throw self::invalidState('Only a pending request can be withdrawn.'))->load(['document', 'requestedBy']);
    }

    /**
     * Staff approve (§8.3): pending → approved, the store's previous approved row → superseded. Call inside the row's
     * tenant context. Returns the row.
     */
    public function approve(SmsSenderId $row, User $staff, string $reason): SmsSenderId
    {
        try {
            $approved = DB::transaction(function () use ($row, $staff, $reason) {
                $rows = SmsSenderId::query()->where('store_id', $row->store_id)
                    ->whereIn('status', [SmsSenderId::PENDING, SmsSenderId::APPROVED])->lockForUpdate()->get();
                $target = $rows->firstWhere('id', $row->id);
                if ($target === null || $target->status !== SmsSenderId::PENDING) {
                    throw self::invalidState('Only a pending request can be approved.');
                }
                $now = now();
                foreach ($rows->where('status', SmsSenderId::APPROVED) as $previous) {
                    $previous->forceFill(['status' => SmsSenderId::SUPERSEDED, 'ended_at' => $now])->save();
                }
                $target->forceFill([
                    'status' => SmsSenderId::APPROVED, 'approved_at' => $now, 'reviewed_by' => $staff->getKey(), 'reviewed_at' => $now,
                    'decision_reason' => $reason,
                ])->save();
                $this->audit->log('sender_id.approved', $target, ['sender_id' => $target->sender_id, 'reason' => $reason, 'provider_registered' => true],
                    $staff, platform: true);

                return $target;
            });
        } catch (UniqueConstraintViolationException) {
            throw new ApiException(409, 'sender_id_taken', 'Another shop already uses this sender ID.');
        }
        SmsSender::forget($approved->store_id);
        $this->notify(SmsMail::SENDER_ID_APPROVED, ['sender_id' => $approved->sender_id]);

        return $approved;
    }

    /** Staff reject (§8.3): pending → rejected with the reason shown to the merchant. */
    public function reject(SmsSenderId $row, User $staff, string $reason): SmsSenderId
    {
        $moved = $this->decide($row, SmsSenderId::PENDING, SmsSenderId::REJECTED, 'sender_id.rejected', $staff, $reason);
        $this->notify(SmsMail::SENDER_ID_REJECTED, ['sender_id' => $moved->sender_id, 'reason' => $reason]);

        return $moved;
    }

    /** Staff revoke (§8.3): approved → revoked; the shop falls back to the shared sender from the next message. */
    public function revoke(SmsSenderId $row, User $staff, string $reason): SmsSenderId
    {
        $moved = $this->decide($row, SmsSenderId::APPROVED, SmsSenderId::REVOKED, 'sender_id.revoked', $staff, $reason);
        SmsSender::forget($moved->store_id);
        $this->notify(SmsMail::SENDER_ID_REVOKED, ['sender_id' => $moved->sender_id, 'reason' => $reason]);

        return $moved;
    }

    private function decide(SmsSenderId $row, string $from, string $to, string $action, User $staff, string $reason): SmsSenderId
    {
        return DB::transaction(function () use ($row, $from, $to, $action, $staff, $reason) {
            $locked = SmsSenderId::query()->whereKey($row->id)->lockForUpdate()->firstOrFail();
            if ($locked->status !== $from) {
                throw self::invalidState($from === SmsSenderId::PENDING ? 'Only a pending request can be rejected.' : 'Only an approved sender ID can be revoked.');
            }
            $now = now();
            $locked->forceFill(['status' => $to, 'reviewed_by' => $staff->getKey(), 'reviewed_at' => $now, 'decision_reason' => $reason, 'ended_at' => $now])->save();
            $this->audit->log($action, $locked, ['sender_id' => $locked->sender_id, 'reason' => $reason], $staff, platform: true);

            return $locked;
        });
    }

    /** P89A-15: config reserved IDs + the platform caller ID, case-insensitively. */
    public static function isReserved(string $senderId): bool
    {
        $reserved = array_map('strtolower', array_filter([...(array) config('sms.reserved_sender_ids', []), (string) config('sms.revesms.caller_id')]));

        return in_array(strtolower($senderId), $reserved, true);
    }

    private function assertNoPending(Store $store): void
    {
        $pending = SmsSenderId::query()->where('store_id', $store->id)->where('status', SmsSenderId::PENDING)->value('id');
        if ($pending !== null) {
            throw new ApiException(409, 'sender_id_request_pending', 'You already have a sender ID request in review. Withdraw it first.', ['request_id' => $pending]);
        }
    }

    /** The store-level pending index (not the global "taken" one) caused the violation. */
    private static function isPendingIndex(UniqueConstraintViolationException $e): bool
    {
        $message = $e->getMessage();

        return str_contains($message, 'sms_sender_ids_one_pending') || str_contains($message, 'sms_sender_ids.store_id');
    }

    /** Sanitised client file name for display (never used as a path). */
    private static function filename(UploadedFile $file): string
    {
        $name = (string) preg_replace('/[\x00-\x1F\x7F\/\\\\"<>]/u', '', $file->getClientOriginalName());
        $name = trim(mb_substr($name, 0, 120));

        return $name !== '' ? $name : 'trade-licence';
    }

    /** @param array<string, string|int|null> $data */
    private function notify(string $kind, array $data): void
    {
        $owner = BillingNotifier::ownerUser();
        if ($owner?->email !== null) {
            Mail::to($owner->email)->send(new SmsMail($kind, BillingNotifier::shopName(), $data));
        }
    }

    private static function invalidState(string $message): ApiException
    {
        return new ApiException(409, 'invalid_state_transition', $message);
    }
}
