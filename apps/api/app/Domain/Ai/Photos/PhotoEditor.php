<?php

declare(strict_types=1);

namespace App\Domain\Ai\Photos;

use App\Domain\Ai\AiException;

/**
 * P89D-39 (Q358 open): the AI photo driver. Presets only (P89D-57): `remove_background` (transparent) or
 * `replace_background` with a preset colour; never a free-text prompt, never a redrawn product. A real driver will call
 * its provider through SafeHttpClient with a fixed host; until one is chosen only FakePhotoEditor exists.
 */
interface PhotoEditor
{
    /** Presets → RGB. `transparent` has no colour. */
    public const PRESETS = [
        'studio_white' => [255, 255, 255],
        'soft_grey' => [236, 236, 236],
        'warm_beige' => [240, 228, 210],
        'pastel_pink' => [248, 222, 228],
        'mint' => [218, 242, 230],
        'transparent' => null,
    ];

    /** @throws AiException */
    public function edit(string $bytes, string $mime, string $operation, string $background, string $seed): PhotoResult;

    public function provider(): string;
}
