<?php

namespace App\Domain\Media\Jobs;

use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\Queue\TenantAware;
use GdImage;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Throwable;

/**
 * Re-encodes the original (strips EXIF and any polyglot payload) and renders variants.
 * Tenant-aware: runs only inside the tenant it was dispatched for. On failure the row is
 * marked failed and all objects are deleted.
 */
class ProcessMedia implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public int $timeout = 120;

    public function __construct(public readonly string $mediaId)
    {
        $this->onQueue('media');
    }

    public function handle(TenantStorage $storage): void
    {
        $media = Media::query()->find($this->mediaId); // tenant-scoped
        if ($media === null || $media->status !== Media::PROCESSING) {
            return;
        }

        try {
            $this->process($media, $storage);
        } catch (Throwable $e) {
            Log::warning('media.processing_failed', ['media_id' => $media->id, 'error' => $e->getMessage()]);
            $storage->deleteAll($media);
            $media->forceFill(['status' => Media::FAILED, 'variants' => []])->save();
        }
    }

    private function process(Media $media, TenantStorage $storage): void
    {
        $disk = $storage->disk($media->disk);
        $bytes = $disk->get($media->path) ?? throw new RuntimeException('Original missing.');

        $size = @getimagesizefromstring($bytes);
        if ($size === false || $size['mime'] !== $media->mime || $size[0] * $size[1] > MediaPurpose::MAX_PIXELS) {
            throw new RuntimeException('Not a valid image of the declared type.');
        }

        $image = @imagecreatefromstring($bytes);
        if (! $image instanceof GdImage) {
            throw new RuntimeException('Image could not be decoded.');
        }

        if ($media->mime === 'image/jpeg') {
            $image = $this->applyExifOrientation($image, $bytes);
        }

        $purpose = MediaPurpose::from($media->purpose);
        [$width, $height] = [imagesx($image), imagesy($image)];

        // Re-encode the original to its own format (GD writes no metadata → EXIF stripped).
        $original = $this->encode($image, $media->mime);
        $disk->put($media->path, $original);

        $variants = [];
        foreach ($purpose->variants() as [$key, $target, $format]) {
            if ($target > $width) {
                continue; // never upscale
            }
            $targetHeight = max(1, (int) round($height * $target / $width));
            $resized = $this->resize($image, $target, $targetHeight);
            $mime = $format === 'png' ? 'image/png' : 'image/webp';
            $path = $storage->path($media->id, "{$key}.{$format}");
            $disk->put($path, $this->encode($resized, $mime));
            imagedestroy($resized);

            $variants[] = ['key' => $key, 'width' => $target, 'height' => $targetHeight, 'mime' => $mime, 'path' => $path];
        }

        imagedestroy($image);

        $media->forceFill([
            'status' => Media::READY,
            'width' => $width,
            'height' => $height,
            'size_bytes' => strlen($original),
            'checksum' => hash('sha256', $original),
            'variants' => $variants,
        ])->save();
    }

    private function resize(GdImage $src, int $w, int $h): GdImage
    {
        $dst = imagecreatetruecolor($w, $h);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $w, $h, imagesx($src), imagesy($src));

        return $dst;
    }

    private function encode(GdImage $image, string $mime): string
    {
        imagesavealpha($image, true);
        ob_start();
        $ok = match ($mime) {
            'image/png' => imagepng($image, null, 6),
            'image/jpeg' => imagejpeg($image, null, 88),
            'image/webp' => imagewebp($image, null, 85),
            default => false,
        };
        $out = (string) ob_get_clean();

        if (! $ok || $out === '') {
            throw new RuntimeException("Encoding {$mime} failed.");
        }

        return $out;
    }

    private function applyExifOrientation(GdImage $image, string $bytes): GdImage
    {
        if (! function_exists('exif_read_data')) {
            return $image;
        }

        $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($bytes));
        $rotated = match ((int) ($exif['Orientation'] ?? 1)) {
            3 => imagerotate($image, 180, 0),
            6 => imagerotate($image, -90, 0),
            8 => imagerotate($image, 90, 0),
            default => null,
        };

        return $rotated instanceof GdImage ? $rotated : $image;
    }
}
