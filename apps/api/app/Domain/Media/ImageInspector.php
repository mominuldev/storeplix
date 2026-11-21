<?php

namespace App\Domain\Media;

/** Reads MIME (from bytes, via finfo) and dimensions without decoding pixel data. */
final class ImageInspector
{
    /**
     * @return array{mime: string, width: int, height: int}|null
     */
    public static function inspect(string $path): ?array
    {
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($path);
        if (! is_string($mime)) {
            return null;
        }

        $size = @getimagesize($path);
        if ($size === false || ($size[0] ?? 0) < 1 || ($size[1] ?? 0) < 1) {
            return ['mime' => $mime, 'width' => 0, 'height' => 0];
        }

        // Both sniffers must agree on the format (defeats header/extension spoofing).
        if (($size['mime'] ?? null) !== $mime) {
            return ['mime' => 'application/octet-stream', 'width' => 0, 'height' => 0];
        }

        return ['mime' => $mime, 'width' => (int) $size[0], 'height' => (int) $size[1]];
    }
}
