<?php

declare(strict_types=1);

namespace App\Domain\Help\Jobs;

use App\Domain\Help\HelpDb;
use App\Domain\Help\HelpMediaService;
use App\Domain\Help\Models\HelpMedia;
use App\Domain\Media\MediaPurpose;
use GdImage;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Throwable;

/**
 * PHASE-8-9C P89C-6: re-encodes a platform help image (GD writes no metadata → EXIF stripped) and renders the WebP
 * variants. Platform job (no tenant). On failure the row is marked failed and its objects are deleted.
 */
class ProcessHelpMedia implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 120;

    public function __construct(public readonly string $mediaId)
    {
        $this->onQueue('media');
    }

    public function handle(): void
    {
        $media = HelpDb::query(HelpMedia::class)->find($this->mediaId);
        if (! $media instanceof HelpMedia || $media->status !== HelpMedia::PROCESSING) {
            return;
        }
        try {
            $this->process($media);
        } catch (Throwable $e) {
            Log::warning('help_media.processing_failed', ['media_id' => $media->id, 'error' => $e->getMessage()]);
            HelpMediaService::deleteObjects($media);
            $media->forceFill(['status' => HelpMedia::FAILED, 'variants' => []])->save();
        }
    }

    private function process(HelpMedia $media): void
    {
        if (! HelpMediaService::ownsPath($media->path)) {
            throw new RuntimeException('Path outside the help prefix.');
        }
        $disk = HelpMediaService::disk($media->disk);
        $bytes = $disk->get($media->path) ?? throw new RuntimeException('Original missing.');
        $size = @getimagesizefromstring($bytes);
        if ($size === false || $size['mime'] !== $media->mime || $size[0] * $size[1] > MediaPurpose::MAX_PIXELS) {
            throw new RuntimeException('Not a valid image of the declared type.');
        }
        $image = @imagecreatefromstring($bytes);
        if (! $image instanceof GdImage) {
            throw new RuntimeException('Image could not be decoded.');
        }
        [$width, $height] = [imagesx($image), imagesy($image)];
        $original = self::encode($image, $media->mime);
        $disk->put($media->path, $original, ['visibility' => 'public']);

        $variants = [];
        foreach (HelpMediaService::VARIANTS as [$key, $target]) {
            if ($target > $width) {
                continue;
            }
            $h = max(1, (int) round($height * $target / $width));
            $dst = imagecreatetruecolor($target, $h);
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            imagefill($dst, 0, 0, (int) imagecolorallocatealpha($dst, 0, 0, 0, 127));
            imagecopyresampled($dst, $image, 0, 0, 0, 0, $target, $h, $width, $height);
            $path = HelpMediaService::directory($media->id)."/{$key}.webp";
            $disk->put($path, self::encode($dst, 'image/webp'), ['visibility' => 'public']);
            imagedestroy($dst);
            $variants[] = ['key' => $key, 'width' => $target, 'height' => $h, 'mime' => 'image/webp', 'path' => $path];
        }
        imagedestroy($image);

        $media->forceFill([
            'status' => HelpMedia::READY,
            'width' => $width,
            'height' => $height,
            'size_bytes' => min(strlen($original), HelpMediaService::MAX_BYTES),
            'variants' => $variants,
        ])->save();
    }

    private static function encode(GdImage $image, string $mime): string
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
}
