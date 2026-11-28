<?php

declare(strict_types=1);

namespace App\Domain\Help;

use Illuminate\Support\Str;

/**
 * Pure helpers over a validated `HelpArticleDoc` (PHASE-8-9C §5, P89C-8): plain text (snippets, sqlite search, word
 * count), the table of contents (H2/H3 anchors `{index}-{kebab text}`), referenced image ids and the content hash.
 */
final class HelpDoc
{
    /** @return array{type: string, content: list<mixed>} */
    public static function empty(): array
    {
        return ['type' => 'doc', 'content' => []];
    }

    /** @param array<string, mixed>|null $doc */
    public static function text(?array $doc): string
    {
        $parts = [];
        foreach (($doc['content'] ?? []) as $block) {
            $parts[] = self::nodeText($block);
        }

        return trim((string) preg_replace('/\s+/u', ' ', implode("\n", array_filter($parts, fn ($p) => $p !== ''))));
    }

    private static function nodeText(mixed $node): string
    {
        if (! is_array($node)) {
            return '';
        }
        if (($node['type'] ?? null) === 'text') {
            return (string) ($node['text'] ?? '');
        }
        if (($node['type'] ?? null) === 'hardBreak') {
            return ' ';
        }
        if (($node['type'] ?? null) === 'image') {
            return trim((string) ($node['attrs']['caption'] ?? ''));
        }
        $out = [];
        foreach (($node['content'] ?? []) as $child) {
            $out[] = self::nodeText($child);
        }
        $glue = in_array($node['type'] ?? null, ['paragraph', 'heading'], true) ? '' : ' ';

        return trim(implode($glue, $out));
    }

    public static function wordCount(string $text): int
    {
        $text = trim($text);

        return $text === '' ? 0 : count(preg_split('/\s+/u', $text) ?: []);
    }

    public static function readMinutes(int $words): int
    {
        return max(1, (int) ceil($words / 200));
    }

    /**
     * @param  array<string, mixed>|null  $doc
     * @return list<array{id: string, text: string, level: int}>
     */
    public static function toc(?array $doc): array
    {
        $out = [];
        foreach (($doc['content'] ?? []) as $i => $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'heading' && in_array($block['attrs']['level'] ?? null, [2, 3], true)) {
                // One entry per H2/H3 in document order, never skipped: the shared renderer gives the n-th heading toc[n].id.
                $text = self::nodeText($block);
                $slug = Str::slug(Str::limit($text, 60, ''), '-', null);
                $out[] = ['id' => $i.($slug !== '' ? '-'.$slug : ''), 'text' => $text, 'level' => (int) $block['attrs']['level']];
            }
        }

        return $out;
    }

    /**
     * @param  array<string, mixed>|null  $doc
     * @return list<string>
     */
    public static function mediaIds(?array $doc): array
    {
        $ids = [];
        foreach (($doc['content'] ?? []) as $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'image' && is_string($block['attrs']['media_id'] ?? null)) {
                $ids[] = strtolower($block['attrs']['media_id']);
            }
        }

        return array_values(array_unique($ids));
    }

    /**
     * Normalises image ids to lower case (ULIDs are stored lower case).
     *
     * @param  array<string, mixed>  $doc
     * @return array<string, mixed>
     */
    public static function normalise(array $doc): array
    {
        foreach (($doc['content'] ?? []) as $i => $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'image' && is_string($block['attrs']['media_id'] ?? null)) {
                $doc['content'][$i]['attrs']['media_id'] = strtolower($block['attrs']['media_id']);
            }
        }

        return $doc;
    }

    /**
     * @param  array<string, mixed>  $body
     * @param  list<string>  $keywords
     */
    public static function hash(string $title, string $summary, array $body, array $keywords): string
    {
        return hash('sha256', (string) json_encode([$title, $summary, $body, $keywords], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    /** Plain text ≤ $max chars around the first hit of any query term (no HTML, P89C-8). */
    public static function snippet(string $text, string $query, int $max = 200): string
    {
        $text = trim($text);
        if (mb_strlen($text) <= $max) {
            return $text;
        }
        $pos = null;
        foreach (preg_split('/\s+/u', mb_strtolower(trim($query))) ?: [] as $term) {
            $term = trim($term, "\"'+-");
            if (mb_strlen($term) < 2) {
                continue;
            }
            $p = mb_stripos($text, $term);
            if ($p !== false && ($pos === null || $p < $pos)) {
                $pos = $p;
            }
        }
        $start = $pos === null ? 0 : max(0, $pos - 60);
        $slice = mb_substr($text, $start, $max - 2);
        if ($start > 0) {
            $slice = '…'.ltrim($slice);
        }

        return mb_substr($slice, 0, $max - 1).(($start + $max - 2) < mb_strlen($text) ? '…' : '');
    }
}
