<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

use App\Domain\Ai\AiException;

/**
 * P89D-53 "output is built, not trusted": the model returns plain strings only (structured output); every string is
 * stripped of markup and control characters, whitespace-collapsed and capped (paragraph 1,000, highlight 160,
 * seo_title 70, meta_description 160), and the rich-text HTML is BUILT here from escaped text (`<p>`, `<ul><li>`) — no
 * model-made HTML ever reaches a page. A variant without a single paragraph is invalid; no usable variant →
 * `ai_output_invalid` (the job fails and refunds).
 */
final class DescriptionOutput
{
    public const PARAGRAPH_MAX = 1000;

    public const HIGHLIGHT_MAX = 160;

    public const SEO_TITLE_MAX = 70;

    public const META_DESCRIPTION_MAX = 160;

    public const MAX_PARAGRAPHS = 8;

    public const MAX_HIGHLIGHTS = 10;

    /**
     * @param  list<mixed>  $raw  decoded `variants` from the driver
     * @return list<array{description_html: string, paragraphs: list<string>, highlights: list<string>, seo_title: string|null, meta_description: string|null}>
     */
    public static function build(array $raw, int $max): array
    {
        $variants = [];
        foreach (array_slice(array_values($raw), 0, max(1, $max)) as $item) {
            if (! is_array($item)) {
                continue;
            }
            $paragraphs = self::list($item['paragraphs'] ?? null, self::PARAGRAPH_MAX, self::MAX_PARAGRAPHS);
            if ($paragraphs === []) {
                continue;
            }
            $highlights = self::list($item['highlights'] ?? null, self::HIGHLIGHT_MAX, self::MAX_HIGHLIGHTS);
            $variants[] = [
                'description_html' => self::html($paragraphs, $highlights),
                'paragraphs' => $paragraphs,
                'highlights' => $highlights,
                'seo_title' => self::text($item['seo_title'] ?? null, self::SEO_TITLE_MAX),
                'meta_description' => self::text($item['meta_description'] ?? null, self::META_DESCRIPTION_MAX),
            ];
        }
        if ($variants === []) {
            throw new AiException(AiException::OUTPUT_INVALID, 'The model returned no usable description.');
        }

        return $variants;
    }

    /** Plain text: tags removed, control / zero-width characters removed, whitespace collapsed, capped. Null when empty. */
    public static function text(mixed $value, int $max): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $text = html_entity_decode(strip_tags(preg_replace('/<\s*(script|style)\b[^>]*>.*?<\s*\/\s*\1\s*>/isu', ' ', $value) ?? ''), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = strip_tags($text); // entity-encoded markup decoded above is stripped too
        $text = preg_replace('/[\p{Cc}\p{Cf}\x{2028}\x{2029}]+/u', ' ', $text) ?? '';
        $text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
        if ($text === '') {
            return null;
        }

        return mb_strlen($text) > $max ? rtrim(mb_substr($text, 0, $max - 1)).'…' : $text;
    }

    /** @return list<string> */
    private static function list(mixed $value, int $max, int $count): array
    {
        if (! is_array($value)) {
            return [];
        }
        $out = [];
        foreach ($value as $item) {
            $text = self::text($item, $max);
            if ($text !== null) {
                $out[] = $text;
            }
            if (count($out) >= $count) {
                break;
            }
        }

        return $out;
    }

    /** @param list<string> $paragraphs @param list<string> $highlights */
    private static function html(array $paragraphs, array $highlights): string
    {
        $e = fn (string $s) => htmlspecialchars($s, ENT_QUOTES | ENT_HTML5 | ENT_SUBSTITUTE, 'UTF-8');
        $html = implode('', array_map(fn (string $p) => '<p>'.$e($p).'</p>', $paragraphs));
        if ($highlights !== []) {
            $html .= '<ul>'.implode('', array_map(fn (string $h) => '<li>'.$e($h).'</li>', $highlights)).'</ul>';
        }

        return $html;
    }
}
