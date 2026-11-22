<?php

namespace App\Domain\Documents;

/** P5B-58: names, notes and addresses print as plain text: control characters stripped, one line, length-capped. */
final class DocumentText
{
    public static function clean(?string $value, int $max = 200): string
    {
        $value = (string) preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) $value);

        return mb_substr(trim((string) preg_replace('/\s+/u', ' ', $value)), 0, $max);
    }
}
