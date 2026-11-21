<?php

namespace App\Domain\Themes;

/** P3-16 limits (constants on both sides). */
final class ThemeLimits
{
    public const MAX_SECTIONS = 30;

    public const MAX_CONFIG_BYTES = 65_536;

    public const MAX_SCHEMA_ERRORS = 50;

    public const RICH_TEXT_SECTION_BYTES = 10_240;

    /** Contract §4.3 table (manifest.json may override). */
    public const MAX_INSTANCES = [
        'hero' => 1,
        'chip-links' => 3,
        'flash-sale' => 1,
        'category-grid' => 3,
        'featured-products' => 3,
        'image-with-text' => 3,
        'feature-tiles' => 3,
        'trust-badges' => 2,
        'reviews-club' => 1,
        'rich-text' => 5,
    ];

    /** Media purposes a theme image may reference. */
    public const MEDIA_PURPOSES = ['page_image', 'product_image', 'logo'];
}
