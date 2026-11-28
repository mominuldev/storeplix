<?php

declare(strict_types=1);

namespace App\Domain\Ai\Photos;

/** An edited image: re-encoded bytes (no metadata), its MIME and size, and the provider's "check edges" flag. */
final readonly class PhotoResult
{
    public function __construct(
        public string $bytes,
        public string $mime,
        public int $width,
        public int $height,
        public bool $checkEdges,
    ) {}
}
