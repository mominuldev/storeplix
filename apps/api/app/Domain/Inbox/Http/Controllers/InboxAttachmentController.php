<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\InboxPresenter;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\URL;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Inbox attachments for members (PHASE-8-8E §7, P88E-7, S241): upload (private disk), the signed 5-minute view link,
 * and the public signed download (tenant from the signature). Images inline, PDFs as attachments; nosniff, sandbox CSP,
 * no-store. Impersonation sees no link (403 `impersonation_attachment_hidden`).
 */
class InboxAttachmentController
{
    public const LINK_MINUTES = 5;

    public function __construct(
        private readonly InboxAttachments $attachments,
        private readonly TenantContext $context,
    ) {}

    /** POST /stores/{store}/inbox/attachments → 201 InboxAttachment. */
    public function store(Request $request, Store $store): JsonResponse
    {
        $request->validate(['file' => ['required', 'file']]);
        /** @var UploadedFile $file */
        $file = $request->file('file');
        $info = $this->attachments->inspect($file);
        if (is_string($info)) {
            throw ValidationException::withMessages(['file' => [$info]]);
        }
        $row = $this->attachments->store($file, $info, $store, InboxAttachment::BY_USER, (string) $request->user()?->getAuthIdentifier());

        return new JsonResponse(['data' => InboxPresenter::attachment($row)], 201, ['Cache-Control' => 'private, no-store']);
    }

    /** GET /stores/{store}/inbox/attachments/{attachment}/link → {url, expires_at}. */
    public function link(Request $request, Store $store, string $attachment): JsonResponse
    {
        if ($request->hasSession() && ImpersonationSession::isImpersonating($request)) {
            throw new ApiException(403, 'impersonation_attachment_hidden', 'Attachments are hidden in an impersonation session.');
        }
        $row = self::visible($store, $attachment, (string) $request->user()?->getAuthIdentifier());
        $status = Media::query()->whereKey($row->media_id)->value('status');
        if ($status === null || $status === Media::FAILED) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if ($status !== Media::READY) {
            throw new ApiException(409, 'inbox_attachment_processing', 'The file is still being processed. Try again in a moment.');
        }
        $expires = now()->addMinutes(self::LINK_MINUTES);

        return new JsonResponse(['data' => [
            'url' => URL::temporarySignedRoute('inbox-attachments.download', $expires, ['attachment' => $row->id, 'tenant' => $row->tenant_id]),
            'expires_at' => $expires->toIso8601ZuluString(),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    /**
     * Attachments a member may open: of this store's messages (any kind) or saved replies, or their own pending upload.
     */
    public static function visible(Store $store, string $id, string $userId): InboxAttachment
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1
            ? InboxAttachment::query()->where('store_id', $store->id)->whereKey(strtolower($id))->first() : null;
        $ok = $row !== null && ($row->message_id !== null || $row->saved_reply_id !== null
            || ($row->uploaded_by_type === InboxAttachment::BY_USER && $row->uploaded_by_user_id === $userId));

        return $ok ? $row : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** GET /inbox-attachments/{attachment}/download (signed, 5 minutes, no session). */
    public function download(Request $request, string $attachment, TenantStorage $storage): StreamedResponse
    {
        return $this->context->run((string) $request->query('tenant'), function () use ($attachment, $storage) {
            $row = InboxAttachment::query()->whereKey(strtolower($attachment))->first();

            return self::stream($row, $storage);
        });
    }

    /** Streams a ready private inbox file under the current tenant's prefix (S241), else 404. */
    public static function stream(?InboxAttachment $row, TenantStorage $storage): StreamedResponse
    {
        $media = $row === null ? null : Media::query()->whereKey($row->media_id)->first();
        if ($row === null || $media === null || $media->purpose !== MediaPurpose::InboxAttachment->value || $media->status !== Media::READY
            || $media->disk !== $storage->privateDiskName() || ! $storage->ownsPath($media->path)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        $pdf = $media->mime === 'application/pdf';

        return $storage->privateDisk()->response($media->path, $row->filename, [
            'Content-Type' => $media->mime,
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "sandbox; default-src 'none'",
            'Cache-Control' => 'private, no-store',
            'Referrer-Policy' => 'no-referrer',
        ], $pdf ? 'attachment' : 'inline');
    }

    /** True when an attachment belongs to a customer / reply row of the conversation (shopper streams, S236). */
    public static function shopperVisible(?InboxAttachment $row, string $conversationId): bool
    {
        return $row !== null && $row->message_id !== null && InboxMessage::query()->whereKey($row->message_id)
            ->where('conversation_id', $conversationId)->whereIn('kind', InboxMessage::SHOPPER_KINDS)->exists();
    }
}
