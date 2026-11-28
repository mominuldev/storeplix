<?php

declare(strict_types=1);

namespace App\Domain\Ai\Photos;

use App\Domain\Ai\AiException;
use GdImage;

/**
 * AI_IMAGE_DRIVER=fake (P89D-39; never in production). Copies the source onto the chosen preset background with GD
 * (a transparent canvas for `remove_background` / `transparent`) and re-encodes it (PNG when transparent, else JPEG; GD
 * writes no metadata, so EXIF is stripped). `check_edges` is flagged on a seeded 10 % (first byte of md5(seed) % 10 = 0).
 */
final class FakePhotoEditor implements PhotoEditor
{
    public function provider(): string
    {
        return 'fake';
    }

    public function edit(string $bytes, string $mime, string $operation, string $background, string $seed): PhotoResult
    {
        $source = @imagecreatefromstring($bytes);
        if (! $source instanceof GdImage) {
            throw new AiException(AiException::IMAGE_UNSUPPORTED, 'The source image could not be decoded.');
        }
        [$w, $h] = [imagesx($source), imagesy($source)];
        $canvas = imagecreatetruecolor($w, $h);
        $rgb = $operation === 'remove_background' ? null : (PhotoEditor::PRESETS[$background] ?? [255, 255, 255]);
        if ($rgb === null) {
            imagealphablending($canvas, false);
            imagesavealpha($canvas, true);
            imagefill($canvas, 0, 0, imagecolorallocatealpha($canvas, 0, 0, 0, 127));
            imagealphablending($canvas, true);
        } else {
            imagefill($canvas, 0, 0, imagecolorallocate($canvas, $rgb[0], $rgb[1], $rgb[2]));
        }
        imagecopy($canvas, $source, 0, 0, 0, 0, $w, $h);
        imagedestroy($source);

        ob_start();
        $png = $rgb === null;
        $png ? imagepng($canvas, null, 6) : imagejpeg($canvas, null, 90);
        $out = (string) ob_get_clean();
        imagedestroy($canvas);

        return new PhotoResult($out, $png ? 'image/png' : 'image/jpeg', $w, $h, hexdec(substr(md5($seed), 0, 2)) % 10 === 0);
    }
}
