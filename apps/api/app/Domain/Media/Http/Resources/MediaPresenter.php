<?php

namespace App\Domain\Media\Http\Resources;

use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;

/**
 * Media and MediaRef payloads (@storeplix/types). All URLs absolute.
 *
 * PHASE-8-7 §5.4: an `expense_receipt` never yields a URL here (these build public CDN URLs whatever the disk); receipts
 * are only opened through the expenses domain's signed 5-minute link.
 */
final class MediaPresenter
{
    /** @return array<string, mixed> */
    public static function media(Media $media): array
    {
        $storage = app(TenantStorage::class);
        $presentable = self::presentable($media);

        return [
            'id' => $media->id,
            'purpose' => $media->purpose,
            'status' => $media->status,
            'mime' => $media->mime,
            'size_bytes' => $media->size_bytes,
            'width' => $media->width,
            'height' => $media->height,
            'alt' => $media->alt,
            'url' => $presentable ? $storage->url($media->disk, $media->path) : null,
            'variants' => $presentable && $media->status === Media::READY
                ? array_map(fn (array $v) => [
                    'key' => $v['key'],
                    'width' => $v['width'],
                    'height' => $v['height'],
                    'mime' => $v['mime'],
                    'url' => $storage->url($media->disk, $v['path']),
                ], $media->variants ?? [])
                : [],
            'created_at' => $media->created_at?->toIso8601ZuluString(),
        ];
    }

    /** @return array{id: string, url: string, width: int, height: int, status: string}|null */
    public static function ref(?Media $media): ?array
    {
        if ($media === null) {
            return null;
        }

        $key = MediaPurpose::tryFrom($media->purpose)?->displayVariant();
        $variant = $media->status === Media::READY && $key !== null ? $media->variant($key) : null;

        return [
            'id' => $media->id,
            'url' => self::url($media, $variant ? [$variant['key']] : []) ?? '',
            'width' => $variant['width'] ?? $media->width,
            'height' => $variant['height'] ?? $media->height,
            'status' => $media->status,
        ];
    }

    /**
     * URL of the first available variant in $keys, else the original (unless $originalFallback is false).
     * Failed media never yields a URL.
     *
     * @param  list<string>  $keys
     */
    public static function url(?Media $media, array $keys, bool $originalFallback = true): ?string
    {
        if ($media === null || $media->status === Media::FAILED || ! self::presentable($media)) {
            return null;
        }

        $storage = app(TenantStorage::class);

        if ($media->status === Media::READY) {
            foreach ($keys as $key) {
                if ($variant = $media->variant($key)) {
                    return $storage->url($media->disk, $variant['path']);
                }
            }
        }

        return $originalFallback ? $storage->url($media->disk, $media->path) : null;
    }

    /** Receipts (private disk, §5.4) never get a URL from the presenter. */
    private static function presentable(Media $media): bool
    {
        return ! (MediaPurpose::tryFrom($media->purpose)?->isPrivate() ?? false); // + PHASE-8-8B purchase_invoice
    }
}
