<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Jobs\ProcessHelpMedia;
use App\Domain\Help\Models\HelpMedia;
use App\Domain\Identity\Models\User;
use App\Domain\Media\ImageInspector;
use App\Domain\Media\MediaPurpose;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Platform help images (PHASE-8-9C P89C-6, S254): staff-only upload, PNG/JPEG/WebP ≤ 5 MB sniffed from the bytes (SVG
 * and anything else refused), 200–6000 px a side, stored on the public CDN disk under `platform/help/{id}/` (never a
 * tenant prefix), re-encoded with EXIF stripped and `w640` / `w1024` / `w1600` WebP variants by ProcessHelpMedia.
 */
final class HelpMediaService
{
    public const MIMES = ['image/png', 'image/jpeg', 'image/webp'];

    public const MAX_BYTES = 5 * 1024 * 1024;

    public const MIN_SIDE = 200;

    public const MAX_SIDE = 6000;

    /** [key, max side px] — never upscaled. */
    public const VARIANTS = [['w640', 640], ['w1024', 1024], ['w1600', 1600]];

    public const UNSUPPORTED = 'Unsupported image. Allowed: PNG, JPEG or WebP up to 5 MB.';

    public static function diskName(): string
    {
        return (string) config('storeplix.media_disk', 'public');
    }

    public static function disk(?string $name = null): Filesystem
    {
        return Storage::disk($name ?? self::diskName());
    }

    public static function directory(string $id): string
    {
        return 'platform/help/'.$id;
    }

    /** True only for a path under the platform help prefix. */
    public static function ownsPath(string $path): bool
    {
        return str_starts_with($path, 'platform/help/') && ! str_contains($path, '..');
    }

    /** @return array{mime: string, width: int, height: int}|string the inspected file, or the 422 message */
    public function inspect(UploadedFile $file): array|string
    {
        if (! $file->isValid() || (int) $file->getSize() > self::MAX_BYTES) {
            return self::UNSUPPORTED;
        }
        $info = ImageInspector::inspect((string) $file->getRealPath());
        if ($info === null || ! in_array($info['mime'], self::MIMES, true) || $info['width'] === 0) {
            return self::UNSUPPORTED;
        }
        if ($info['width'] * $info['height'] > MediaPurpose::MAX_PIXELS) {
            return 'This image is too large (over 40 megapixels).';
        }
        if ($info['width'] < self::MIN_SIDE || $info['height'] < self::MIN_SIDE || $info['width'] > self::MAX_SIDE || $info['height'] > self::MAX_SIDE) {
            return 'Each side must be between '.self::MIN_SIDE.' and '.self::MAX_SIDE.' px.';
        }

        return $info;
    }

    /** @param array{mime: string, width: int, height: int} $info */
    public function store(UploadedFile $file, array $info, User $staff, ?string $alt): HelpMedia
    {
        $id = strtolower((string) Str::ulid());
        $bytes = (string) file_get_contents((string) $file->getRealPath());
        $path = self::directory($id).'/original.'.MediaPurpose::extensionFor($info['mime']);
        self::disk()->put($path, $bytes, ['visibility' => 'public']);

        /** @var HelpMedia $media */
        $media = HelpDb::make(HelpMedia::class);
        $media->id = $id;
        $media->forceFill([
            'disk' => self::diskName(),
            'path' => $path,
            'mime' => $info['mime'],
            'size_bytes' => strlen($bytes),
            'width' => $info['width'],
            'height' => $info['height'],
            'variants' => [],
            'status' => HelpMedia::PROCESSING,
            'alt' => $alt !== null && trim($alt) !== '' ? mb_substr(trim($alt), 0, 200) : null,
            'uploaded_by' => $staff->id,
        ])->save();

        ProcessHelpMedia::dispatch($media->id);

        return HelpDb::query(HelpMedia::class)->findOrFail($id);
    }

    public static function url(string $disk, string $path): string
    {
        $base = config('storeplix.media_url');
        if (is_string($base) && $base !== '') {
            return rtrim($base, '/').'/'.ltrim($path, '/');
        }
        $url = self::disk($disk)->url($path);

        return str_starts_with($url, 'http') ? $url : rtrim((string) config('app.url'), '/').'/'.ltrim($url, '/');
    }

    /** @return array<string, mixed> HelpMediaRef */
    public static function ref(HelpMedia $m): array
    {
        $ready = $m->status === HelpMedia::READY;
        $variants = [];
        if ($ready) {
            foreach ($m->variants ?? [] as $v) {
                $variants[(string) $v['key']] = self::url($m->disk, (string) $v['path']);
            }
        }
        $largest = $variants !== [] ? end($variants) : null;

        return [
            'id' => $m->id,
            'status' => $m->status,
            'url' => $ready ? ($largest ?: self::url($m->disk, $m->path)) : null,
            'width' => $ready ? $m->width : null,
            'height' => $ready ? $m->height : null,
            'variants' => (object) $variants,
            'alt' => $m->alt,
        ];
    }

    /**
     * media_id → HelpMediaRef for the given ids (unknown ids are left out).
     *
     * @param  list<string>  $ids
     * @return array<string, array<string, mixed>>
     */
    public static function refs(array $ids, bool $readyOnly = false): array
    {
        if ($ids === []) {
            return [];
        }
        $out = [];
        foreach (HelpMedia::query()->whereIn('id', $ids)->get() as $m) {
            if ($readyOnly && $m->status !== HelpMedia::READY) {
                continue;
            }
            $out[$m->id] = self::ref($m);
        }

        return $out;
    }

    public static function deleteObjects(HelpMedia $m): void
    {
        if (self::ownsPath($m->path)) {
            self::disk($m->disk)->deleteDirectory(self::directory($m->id));
        }
    }
}
