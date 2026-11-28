<?php

declare(strict_types=1);

namespace App\Domain\Sms\SenderIds;

use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Sms\Models\SmsSenderId;

/**
 * SmsSenderIdRequest (openapi 1.23.0, PHASE-8-9A §8). The trade licence shows only mime, size and filename (P89A-16:
 * merchants never download it). Load `document` and `requestedBy` before presenting (inside the tenant context, or on
 * the admin connection for staff).
 */
final class SenderIdPresenter
{
    /** @return array<string, mixed> */
    public static function request(SmsSenderId $row, ?Media $document = null, ?User $requestedBy = null): array
    {
        $document ??= $row->relationLoaded('document') ? $row->document : null;
        $requestedBy ??= $row->relationLoaded('requestedBy') ? $row->requestedBy : null;

        return [
            'id' => $row->id,
            'sender_id' => $row->sender_id,
            'status' => $row->status,
            'business_name' => $row->business_name,
            'uses' => array_values((array) $row->uses),
            'note' => $row->note,
            'document' => [
                'mime' => (string) ($document?->mime ?? 'application/pdf'),
                'size_bytes' => (int) ($document?->size_bytes ?? 0),
                'filename' => self::filename($document),
            ],
            'requested_by' => $requestedBy !== null ? ['id' => $requestedBy->id, 'name' => (string) $requestedBy->name] : null,
            'requested_at' => $row->requested_at->toIso8601ZuluString(),
            'reviewed_at' => $row->reviewed_at?->toIso8601ZuluString(),
            'decision_reason' => $row->decision_reason,
        ];
    }

    /**
     * The sanitised uploaded file name, kept in the private document's `media.alt` (unused for documents; no new
     * column), else "trade-licence.{ext}".
     */
    public static function filename(?Media $document): string
    {
        $name = $document?->alt;
        if (is_string($name) && $name !== '') {
            return mb_substr($name, 0, 120);
        }

        return 'trade-licence.'.match ((string) $document?->mime) {
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', default => 'pdf',
        };
    }
}
