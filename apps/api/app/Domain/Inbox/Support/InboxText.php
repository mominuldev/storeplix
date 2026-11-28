<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

/**
 * Plain-text bodies (PHASE-8-8E P88E-13, P88E-23, §11.2): control characters stripped (newlines and tabs kept), email
 * HTML turned into text server-side, quoted history and signatures trimmed. Nothing here ever returns HTML.
 */
final class InboxText
{
    public static function clean(?string $value): string
    {
        $value = str_replace(["\r\n", "\r"], "\n", (string) $value);
        $value = (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $value);
        $value = (string) preg_replace("/\n{4,}/", "\n\n\n", $value);

        return trim($value);
    }

    /** One line, ≤ $max characters (list previews, email subjects). */
    public static function line(?string $value, int $max): string
    {
        $value = trim((string) preg_replace('/\s+/u', ' ', self::clean($value)));

        return mb_strlen($value) > $max ? rtrim(mb_substr($value, 0, $max - 1)).'…' : $value;
    }

    /** HTML → text without tags, scripts or styles (S242). */
    public static function htmlToText(string $html): string
    {
        $html = (string) preg_replace('#<(script|style|head)\b[^>]*>.*?</\1>#is', '', $html);
        $html = (string) preg_replace('#<br\s*/?>#i', "\n", $html);
        $html = (string) preg_replace('#</(p|div|li|tr|h[1-6]|blockquote)>#i', "\n", $html);
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = (string) preg_replace("/[ \t]+/", ' ', $text);

        return self::clean((string) preg_replace("/ *\n */", "\n", $text));
    }

    /**
     * §11.2 step 4: drop quoted history (`On … wrote:`, Outlook "-----Original Message-----" / "From:" blocks, `>`
     * lines) and the signature (`-- `), then cap at $max characters ("…").
     */
    public static function trimEmail(string $text, int $max = 4000): string
    {
        $lines = explode("\n", str_replace(["\r\n", "\r"], "\n", $text));
        $kept = [];
        foreach ($lines as $line) {
            $trimmed = rtrim($line);
            if ($trimmed === '--' || $trimmed === '-- ' || $line === '-- '
                || preg_match('/^\s*On\b.{0,300}\bwrote:\s*$/iu', $trimmed) === 1
                || preg_match('/^\s*-{2,}\s*Original Message\s*-{2,}/i', $trimmed) === 1
                || preg_match('/^\s*_{10,}\s*$/', $trimmed) === 1
                || (preg_match('/^\s*From:\s.+/i', $trimmed) === 1 && $kept !== [])) {
                break;
            }
            if (str_starts_with(ltrim($line), '>')) {
                continue;
            }
            $kept[] = $line;
        }
        $out = self::clean(implode("\n", $kept));
        if ($out === '') {
            $out = self::clean($text); // a reply that is only a quote: keep what was sent
        }

        return mb_strlen($out) > $max ? rtrim(mb_substr($out, 0, $max - 1)).'…' : $out;
    }

    /** `017••••5678` (P88E conventions: masked to shoppers). */
    public static function maskPhone(?string $msisdn): string
    {
        $digits = preg_replace('/\D/', '', (string) $msisdn) ?? '';
        $local = str_starts_with($digits, '880') ? '0'.substr($digits, 3) : $digits;
        if (strlen($local) < 7) {
            return '•••';
        }

        return substr($local, 0, 3).'••••'.substr($local, -4);
    }

    /** `8801711552211` → `01711552211` (members see the full local number). */
    public static function localPhone(?string $msisdn): ?string
    {
        if ($msisdn === null || $msisdn === '') {
            return null;
        }

        return str_starts_with($msisdn, '880') ? '0'.substr($msisdn, 3) : $msisdn;
    }
}
