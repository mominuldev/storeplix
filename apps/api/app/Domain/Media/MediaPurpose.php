<?php

namespace App\Domain\Media;

/**
 * Upload rules per purpose (Phase 2 contract §1.5). MIME is always sniffed from bytes.
 */
enum MediaPurpose: string
{
    case Logo = 'logo';
    case Favicon = 'favicon';
    case ProductImage = 'product_image';
    case PageImage = 'page_image';

    public const MAX_PIXELS = 40_000_000;

    /** @return list<string> */
    public function mimes(): array
    {
        return match ($this) {
            self::Favicon => ['image/png'],
            default => ['image/png', 'image/jpeg', 'image/webp'],
        };
    }

    public function maxBytes(): int
    {
        return match ($this) {
            self::Logo => 2 * 1024 * 1024,
            self::Favicon => 1024 * 1024,
            default => 5 * 1024 * 1024,
        };
    }

    /** @return array{0: int, 1: int} min/max px per side */
    public function sideBounds(): array
    {
        return match ($this) {
            self::Logo => [64, 4096],
            self::Favicon => [64, 1024],
            default => [200, 6000],
        };
    }

    public function mustBeSquare(): bool
    {
        return $this === self::Favicon;
    }

    /**
     * Variant specs: [key, max side px, format]. Never upscaled: a variant larger than the source is skipped.
     *
     * @return list<array{0: string, 1: int, 2: string}>
     */
    public function variants(): array
    {
        return match ($this) {
            self::Logo => [['w160', 160, 'webp'], ['w320', 320, 'webp'], ['w640', 640, 'webp']],
            self::Favicon => [['favicon_32', 32, 'png'], ['apple_180', 180, 'png'], ['icon_192', 192, 'png'], ['icon_512', 512, 'png']],
            default => [['w320', 320, 'webp'], ['w640', 640, 'webp'], ['w1024', 1024, 'webp'], ['w1600', 1600, 'webp']],
        };
    }

    /** Variant used for compact MediaRef / display. */
    public function displayVariant(): string
    {
        return match ($this) {
            self::Logo => 'w320',
            self::Favicon => 'icon_192',
            default => 'w640',
        };
    }

    public static function extensionFor(string $mime): string
    {
        return match ($mime) {
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'image/webp' => 'webp',
            default => 'bin',
        };
    }
}
