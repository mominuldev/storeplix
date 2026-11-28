<?php

declare(strict_types=1);

namespace App\Domain\Support\Http\Controllers;

use App\Domain\Admin\Impersonation\ImpersonationSession;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use App\Domain\Support\SupportAttachments;
use App\Domain\Support\SupportPresenter;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\URL;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Ticket attachments for members (PHASE-8-9C P89C-15, S255): upload (private disk, tenant prefix), the signed 5-minute
 * link (never for a note attachment → 404; impersonation → 403 `impersonation_attachment_hidden`), and the public signed
 * download (tenant from the signature). Images inline, PDFs as attachments; nosniff, sandbox CSP, no-store.
 */
class SupportAttachmentController
{
    public const LINK_MINUTES = 5;

    public function __construct(
        private readonly SupportAttachments $attachments,
        private readonly TenantContext $context,
    ) {}

    public function store(Request $request): JsonResponse
    {
        $request->validate(['file' => ['required', 'file']]);
        /** @var UploadedFile $file */
        $file = $request->file('file');
        $info = $this->attachments->inspect($file);
        if (is_string($info)) {
            throw ValidationException::withMessages(['file' => [$info]]);
        }
        $row = $this->attachments->store($file, $info, SupportTicketAttachment::BY_MERCHANT, (string) $request->user()?->getAuthIdentifier());
        $status = Media::query()->whereKey($row->media_id)->value('status');

        return new JsonResponse(['data' => SupportPresenter::attachment($row, is_string($status) ? $status : null)], 201, ['Cache-Control' => 'private, no-store']);
    }

    public function link(Request $request, string $attachment): JsonResponse
    {
        if ($request->hasSession() && ImpersonationSession::isImpersonating($request)) {
            throw new ApiException(403, 'impersonation_attachment_hidden', 'Attachments are hidden in an impersonation session.');
        }
        $row = self::merchantVisible($attachment, (string) $request->user()?->getAuthIdentifier());
        $status = Media::query()->whereKey($row->media_id)->value('status');
        if ($status === null || $status === Media::FAILED) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if ($status !== Media::READY) {
            throw new ApiException(409, 'support_attachment_processing', 'The file is still being processed. Try again in a moment.');
        }
        $expires = now()->addMinutes(self::LINK_MINUTES);

        return new JsonResponse(['data' => [
            'url' => URL::temporarySignedRoute('support-attachments.download', $expires, ['attachment' => $row->id, 'tenant' => $row->tenant_id]),
            'expires_at' => $expires->toIso8601ZuluString(),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    /**
     * Attachments a member may open (S251): on a merchant / staff message of the tenant, or their own pending upload.
     * Never an attachment of an internal note.
     */
    public static function merchantVisible(string $id, string $userId): SupportTicketAttachment
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? SupportTicketAttachment::query()->whereKey(strtolower($id))->first() : null;
        $ok = $row !== null && ($row->message_id !== null
            ? SupportTicketMessage::query()->whereKey($row->message_id)->whereIn('kind', [SupportTicketMessage::MERCHANT, SupportTicketMessage::STAFF])->exists()
            : ($row->uploaded_by_type === SupportTicketAttachment::BY_MERCHANT && $row->uploaded_by_user_id === $userId));

        return $ok ? $row : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** GET /support-attachments/{attachment}/download (signed, 5 minutes, no session). */
    public function download(Request $request, string $attachment, TenantStorage $storage): StreamedResponse
    {
        return $this->context->run((string) $request->query('tenant'), function () use ($attachment, $storage) {
            $row = SupportTicketAttachment::query()->whereKey(strtolower($attachment))->first();
            // S251: a signed link is only ever issued for merchant / staff message files; re-check the kind anyway.
            if ($row !== null && $row->message_id !== null
                && ! SupportTicketMessage::query()->whereKey($row->message_id)->whereIn('kind', [SupportTicketMessage::MERCHANT, SupportTicketMessage::STAFF])->exists()) {
                $row = null;
            }

            return self::stream($row, $storage);
        });
    }

    /** Streams a ready private support file under the current tenant's prefix (S255), else 404. */
    public static function stream(?SupportTicketAttachment $row, TenantStorage $storage): StreamedResponse
    {
        $media = $row === null ? null : Media::query()->whereKey($row->media_id)->first();
        if ($row === null || $media === null || $media->purpose !== MediaPurpose::SupportAttachment->value || $media->status !== Media::READY
            || $media->disk !== $storage->privateDiskName() || ! $storage->ownsPath($media->path)) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }

        return $storage->privateDisk()->response($media->path, $row->filename, [
            'Content-Type' => $media->mime,
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "sandbox; default-src 'none'",
            'Cache-Control' => 'private, no-store',
            'Referrer-Policy' => 'no-referrer',
        ], $media->mime === 'application/pdf' ? 'attachment' : 'inline');
    }
}
