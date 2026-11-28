<?php

declare(strict_types=1);

namespace App\Domain\Support;

/** Plain-text hygiene for ticket subjects and bodies (never HTML): control characters out, CRLF → LF, trimmed. */
final class SupportText
{
    public static function clean(string $text): string
    {
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        $text = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text);

        return trim($text);
    }

    public static function line(string $text, int $max): string
    {
        return mb_substr(trim((string) preg_replace('/\s+/u', ' ', self::clean($text))), 0, $max);
    }
}
