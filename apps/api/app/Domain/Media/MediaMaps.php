<?php

namespace App\Domain\Media;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\Models\Media;

/** {id → MediaRef} (merchant) and {id → StorefrontMedia} (public) maps for exactly the given ids. */
final class MediaMaps
{
    /**
     * @param  list<string>  $ids
     * @return array<string, Media> tenant-scoped, keyed by id
     */
    public static function load(array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids, fn ($id) => is_string($id) && preg_match('/^[0-9a-z]{26}$/', $id) === 1)));
        if ($ids === []) {
            return [];
        }

        return Media::query()->whereIn('id', $ids)->get()->keyBy('id')->all();
    }

    /**
     * @param  list<string>  $ids
     * @return array<string, array<string, mixed>>|object
     */
    public static function refs(array $ids): array|object
    {
        $out = [];
        foreach (self::load($ids) as $id => $media) {
            $out[$id] = MediaPresenter::ref($media);
        }

        return $out === [] ? new \stdClass : $out;
    }

    /**
     * StorefrontMedia map; failed media is omitted (the storefront falls back to its demo image).
     *
     * @param  list<string>  $ids
     * @return array<string, array<string, mixed>>|object
     */
    public static function storefront(array $ids): array|object
    {
        $out = [];
        foreach (self::load($ids) as $id => $media) {
            if ($media->status !== Media::FAILED) {
                $out[$id] = self::storefrontMedia($media);
            }
        }

        return $out === [] ? new \stdClass : $out;
    }

    /** @return array{id: string, url: string, width: int, height: int, alt: string|null, srcset: list<array{url: string, width: int}>} */
    public static function storefrontMedia(Media $media): array
    {
        $storage = app(TenantStorage::class);
        $srcset = [];
        $largest = null;
        if ($media->status === Media::READY) {
            foreach ($media->variants ?? [] as $variant) {
                $srcset[] = ['url' => $storage->url($media->disk, $variant['path']), 'width' => (int) $variant['width']];
                if ($largest === null || $variant['width'] > $largest['width']) {
                    $largest = $variant;
                }
            }
            usort($srcset, fn ($a, $b) => $a['width'] <=> $b['width']);
        }

        return [
            'id' => $media->id,
            'url' => $largest ? $storage->url($media->disk, $largest['path']) : (string) MediaPresenter::url($media, []),
            'width' => (int) ($largest['width'] ?? $media->width),
            'height' => (int) ($largest['height'] ?? $media->height),
            'alt' => $media->alt,
            'srcset' => $srcset,
        ];
    }
}
