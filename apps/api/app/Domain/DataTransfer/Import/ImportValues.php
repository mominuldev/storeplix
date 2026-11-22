<?php

namespace App\Domain\DataTransfer\Import;

use App\Domain\Catalog\Models\Product;

/** Cell normalisers for imports (§5.2 / §5.3). */
final class ImportValues
{
    private const BANGLA_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

    public static function digits(string $value): string
    {
        return str_replace(self::BANGLA_DIGITS, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], $value);
    }

    /**
     * Major units → paisa. Strips ৳ / tk / taka / bdt, spaces and thousands separators; Bangla digits; ≤ 2 decimals.
     *
     * @return array{0: int|null, 1: string|null, 2: bool} [paisa, error, changed (needs a "read as" warning)]
     */
    public static function money(string $raw): array
    {
        $raw = trim($raw);
        if ($raw === '') {
            return [null, null, false];
        }
        $clean = self::digits(mb_strtolower($raw));
        $clean = str_replace(['৳', 'taka', 'bdt', 'tk', 'টাকা', ' ', "\u{00A0}", ','], '', $clean);
        $clean = rtrim($clean, '/-');
        if (preg_match('/^(\d{1,10})(?:\.(\d{1,2}))?$/', $clean, $m) !== 1) {
            return [null, "\"{$raw}\" isn't a price.", false];
        }
        $paisa = ((int) $m[1]) * 100 + (int) str_pad($m[2] ?? '0', 2, '0');
        if ($paisa > Product::MAX_AMOUNT) {
            return [null, 'The price is too high.', false];
        }

        return [$paisa, null, $clean !== $raw];
    }

    public static function formatMoney(int $paisa): string
    {
        $major = intdiv($paisa, 100);
        $minor = $paisa % 100;

        return '৳ '.number_format($major).($minor !== 0 ? '.'.str_pad((string) $minor, 2, '0', STR_PAD_LEFT) : '');
    }

    /** "3450" or "3450.5" style major units for exports (never negative, never prefixed). */
    public static function major(?int $paisa): string
    {
        if ($paisa === null) {
            return '';
        }
        $minor = $paisa % 100;

        return intdiv($paisa, 100).($minor !== 0 ? '.'.str_pad((string) $minor, 2, '0', STR_PAD_LEFT) : '');
    }

    /** @return array{0: int|null, 1: string|null} integer (Bangla digits ok), error */
    public static function integer(string $raw): array
    {
        $clean = str_replace([',', ' '], '', self::digits(trim($raw)));
        if ($clean === '') {
            return [null, null];
        }
        if (preg_match('/^-?\d{1,9}(\.0+)?$/', $clean) !== 1) {
            return [null, "\"{$raw}\" isn't a whole number."];
        }

        return [(int) $clean, null];
    }

    /** @return array{0: float|null, 1: string|null} */
    public static function decimal(string $raw): array
    {
        $clean = str_replace([',', ' '], '', self::digits(trim($raw)));
        if ($clean === '') {
            return [null, null];
        }
        if (! is_numeric($clean) || (float) $clean < 0) {
            return [null, "\"{$raw}\" isn't a number."];
        }

        return [(float) $clean, null];
    }

    public static function bool(string $raw): ?bool
    {
        return match (mb_strtolower(trim($raw))) {
            'yes', 'true', '1', 'y' => true,
            'no', 'false', '0', 'n' => false,
            default => null,
        };
    }

    /** Removes control characters (keeps \n when asked) and trims. */
    public static function text(string $raw, bool $keepNewlines = false): string
    {
        $value = str_replace("\r\n", "\n", $raw);
        $value = (string) preg_replace($keepNewlines ? '/[\x00-\x09\x0B-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u', $keepNewlines ? '' : ' ', $value);

        return trim($value);
    }

    /**
     * Plain text (or stripped HTML) → RichTextDoc: blank line = new paragraph, single newline = hardBreak.
     *
     * @return array{0: array<string, mixed>|null, 1: bool} [doc, html was stripped]
     */
    public static function richText(string $raw): array
    {
        $stripped = false;
        $text = $raw;
        if (preg_match('/<[a-z!\/][^>]*>/i', $text) === 1) {
            $text = (string) preg_replace('/<\s*br\s*\/?>/i', "\n", $text);
            $text = (string) preg_replace('/<\/\s*(p|div|li|h[1-6])\s*>/i', "\n\n", $text);
            $text = html_entity_decode(strip_tags($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $stripped = true;
        }
        $text = self::text($text, true);
        if ($text === '') {
            return [null, $stripped];
        }

        $paragraphs = [];
        foreach (preg_split('/\n\s*\n+/', $text) ?: [] as $block) {
            $lines = array_values(array_filter(array_map('trim', explode("\n", $block)), fn ($l) => $l !== ''));
            if ($lines === []) {
                continue;
            }
            $content = [];
            foreach ($lines as $i => $line) {
                if ($i > 0) {
                    $content[] = ['type' => 'hardBreak'];
                }
                foreach (mb_str_split($line, 5000) as $piece) {
                    $content[] = ['type' => 'text', 'text' => $piece];
                }
            }
            $paragraphs[] = ['type' => 'paragraph', 'content' => $content];
            if (count($paragraphs) >= 100) {
                break;
            }
        }

        return [['type' => 'doc', 'content' => $paragraphs], $stripped];
    }

    /** RichTextDoc → plain text (exports): paragraphs separated by a blank line, hardBreak = newline. */
    public static function plainText(?array $doc): string
    {
        if ($doc === null) {
            return '';
        }
        $out = [];
        $walk = function (array $node) use (&$walk): string {
            if (($node['type'] ?? null) === 'text') {
                return (string) ($node['text'] ?? '');
            }
            if (($node['type'] ?? null) === 'hardBreak') {
                return "\n";
            }
            $text = '';
            foreach ($node['content'] ?? [] as $child) {
                $text .= $walk($child)."\u{0}";
            }

            return str_replace("\u{0}", in_array($node['type'] ?? '', ['bulletList', 'orderedList', 'blockquote', 'listItem'], true) ? "\n" : '', $text);
        };
        foreach ($doc['content'] ?? [] as $block) {
            $out[] = trim($walk($block));
        }

        return implode("\n\n", array_filter($out, fn ($p) => $p !== ''));
    }

    /**
     * @return list<string> trimmed, lowercased, unique, non-empty
     */
    public static function tags(string $raw): array
    {
        $tags = array_map(fn ($t) => mb_strtolower(self::text($t)), explode(',', $raw));

        return array_values(array_unique(array_filter($tags, fn ($t) => $t !== '')));
    }
}
