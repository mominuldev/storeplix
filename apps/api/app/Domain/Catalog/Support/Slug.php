<?php

namespace App\Domain\Catalog\Support;

use Closure;
use Illuminate\Support\Str;

/** Slugs for catalog rows: ASCII slug of the name; Bangla-only names fall back to "{prefix}-xxxxxx". */
final class Slug
{
    public static function from(string $name, string $prefix, int $max): string
    {
        $ascii = (string) preg_replace('/[^\x20-\x7E]+/', ' ', $name);
        $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-');

        return $slug !== '' ? rtrim(substr($slug, 0, $max), '-') : $prefix.'-'.Str::lower(Str::random(6));
    }

    /**
     * A default (not user-chosen) slug never collides: "-2", "-3"… are appended.
     *
     * @param  Closure(string): bool  $taken
     */
    public static function unique(string $base, int $max, Closure $taken): string
    {
        $base = rtrim(substr($base, 0, $max - 4), '-');
        $slug = $base;
        for ($i = 2; $taken($slug); $i++) {
            $slug = "{$base}-{$i}";
        }

        return $slug;
    }

    /** Removes control characters (C0 + DEL) and trims. */
    public static function clean(string $value, bool $keepNewlines = false): string
    {
        $pattern = $keepNewlines ? '/[\x00-\x09\x0B-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u';

        return trim((string) preg_replace($pattern, $keepNewlines ? '' : ' ', $value));
    }
}
