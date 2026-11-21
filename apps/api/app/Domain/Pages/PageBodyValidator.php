<?php

namespace App\Domain\Pages;

use App\Domain\Media\Models\Media;
use App\Domain\Themes\SafeHref;

/**
 * Validates store_pages.body (PageBlock[], PHASE-3-CONTRACT §4.5). Unknown keys/types → error.
 * Returns normalised blocks (trimmed strings, nullable fields filled with null).
 */
final class PageBodyValidator
{
    public const MAX_BLOCKS = 40;

    public const MAX_BYTES = 131_072;

    public const RICH_TEXT_BYTES = 20_480;

    public const ID_PATTERN = '/^[a-z0-9]{8,16}$/';

    /** type => [allowed keys (besides id, type), nullable keys] */
    private const TYPES = [
        'heading' => [['text', 'level'], []],
        'rich_text' => [['doc'], []],
        'image' => [['media_id', 'alt', 'caption'], ['media_id', 'alt', 'caption']],
        'button' => [['label', 'href', 'style'], []],
        'callout' => [['title', 'items', 'tone'], ['title']],
        'table' => [['headers', 'rows'], []],
    ];

    /** @var array<string, list<string>> */
    private array $errors = [];

    /** @var list<string> */
    private array $mediaIds = [];

    /**
     * @return array{0: list<array<string, mixed>>, 1: array<string, list<string>>} [normalised body, errors]
     */
    public static function validate(mixed $body, string $path = 'body', bool $checkMedia = true): array
    {
        $v = new self;
        $out = $v->run($body, $path);

        if ($checkMedia && $v->errors === [] && $v->mediaIds !== []) {
            $v->checkMedia($out, $path);
        }

        return [$out, $v->errors];
    }

    /**
     * Media ids referenced by a (valid) body.
     *
     * @param  list<array<string, mixed>>  $body
     * @return list<string>
     */
    public static function mediaIds(array $body): array
    {
        $ids = [];
        foreach ($body as $block) {
            if (($block['type'] ?? null) === 'image' && is_string($block['media_id'] ?? null)) {
                $ids[] = $block['media_id'];
            }
        }

        return array_values(array_unique($ids));
    }

    /** @return list<array<string, mixed>> */
    private function run(mixed $body, string $path): array
    {
        if (! is_array($body) || ! array_is_list($body)) {
            $this->errors[$path][] = 'Must be a list of blocks.';

            return [];
        }
        if (count($body) > self::MAX_BLOCKS) {
            $this->errors[$path][] = 'A page can have at most '.self::MAX_BLOCKS.' blocks.';

            return [];
        }
        if (strlen((string) json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) > self::MAX_BYTES) {
            $this->errors[$path][] = 'This page is too long (max 128 KB).';

            return [];
        }

        $ids = [];
        $out = [];
        foreach ($body as $i => $block) {
            $p = "{$path}.{$i}";
            if (! is_array($block) || ($block !== [] && array_is_list($block))) {
                $this->errors[$p][] = 'Must be a block object.';

                continue;
            }

            $type = $block['type'] ?? null;
            if (! is_string($type) || ! isset(self::TYPES[$type])) {
                $this->errors["{$p}.type"][] = 'Unknown block type.';

                continue;
            }

            $id = $block['id'] ?? null;
            if (! is_string($id) || preg_match(self::ID_PATTERN, $id) !== 1) {
                $this->errors["{$p}.id"][] = 'Block id must be 8–16 lowercase letters or digits.';
            } elseif (isset($ids[$id])) {
                $this->errors["{$p}.id"][] = 'Block ids must be unique.';
            } else {
                $ids[$id] = true;
            }

            [$keys, $nullable] = self::TYPES[$type];
            foreach (array_keys($block) as $key) {
                if (! in_array($key, ['id', 'type', ...$keys], true)) {
                    $this->errors["{$p}.{$key}"][] = 'Unknown field.';
                }
            }

            $normalised = ['id' => $id, 'type' => $type];
            foreach ($keys as $key) {
                if (! array_key_exists($key, $block)) {
                    if (in_array($key, $nullable, true)) {
                        $normalised[$key] = null;

                        continue;
                    }
                    $this->errors["{$p}.{$key}"][] = 'This field is required.';

                    continue;
                }
                $normalised[$key] = $block[$key];
            }

            $out[] = $this->{'block'.str_replace('_', '', ucwords($type, '_'))}($normalised, $p);
        }

        return $out;
    }

    private function blockHeading(array $b, string $p): array
    {
        $b['text'] = $this->text($b['text'] ?? null, "{$p}.text", 1, 120);
        if (! in_array($b['level'] ?? null, [2, 3], true)) {
            $this->errors["{$p}.level"][] = 'Heading level must be 2 or 3.';
        }

        return $b;
    }

    private function blockRichText(array $b, string $p): array
    {
        if (array_key_exists('doc', $b)) {
            $this->merge(RichTextValidator::validate($b['doc'], "{$p}.doc", self::RICH_TEXT_BYTES));
        }

        return $b;
    }

    private function blockImage(array $b, string $p): array
    {
        if ($b['media_id'] !== null) {
            if (! is_string($b['media_id']) || preg_match('/^[0-9a-z]{26}$/i', $b['media_id']) !== 1) {
                $this->errors["{$p}.media_id"][] = 'Unknown image.';
            } else {
                $b['media_id'] = strtolower($b['media_id']);
                $this->mediaIds[] = $b['media_id'];
            }
        }
        $b['alt'] = $b['alt'] === null ? null : $this->text($b['alt'], "{$p}.alt", 0, 160);
        $b['caption'] = $b['caption'] === null ? null : $this->text($b['caption'], "{$p}.caption", 0, 200);

        return $b;
    }

    private function blockButton(array $b, string $p): array
    {
        $b['label'] = $this->text($b['label'] ?? null, "{$p}.label", 1, 40);
        $href = is_string($b['href'] ?? null) ? trim($b['href']) : $b['href'] ?? null;
        if (! SafeHref::button($href)) {
            $this->errors["{$p}.href"][] = 'This link is not allowed.';
        }
        $b['href'] = $href;
        if (! in_array($b['style'] ?? null, ['primary', 'secondary'], true)) {
            $this->errors["{$p}.style"][] = 'Style must be primary or secondary.';
        }

        return $b;
    }

    private function blockCallout(array $b, string $p): array
    {
        $b['title'] = $b['title'] === null ? null : $this->text($b['title'], "{$p}.title", 0, 80);
        $items = $b['items'] ?? null;
        if (! is_array($items) || ! array_is_list($items) || count($items) < 1 || count($items) > 8) {
            $this->errors["{$p}.items"][] = 'A callout needs 1–8 items.';
        } else {
            foreach ($items as $i => $item) {
                $items[$i] = $this->text($item, "{$p}.items.{$i}", 1, 200);
            }
            $b['items'] = $items;
        }
        if (! in_array($b['tone'] ?? null, ['info', 'success', 'warning'], true)) {
            $this->errors["{$p}.tone"][] = 'Tone must be info, success or warning.';
        }

        return $b;
    }

    private function blockTable(array $b, string $p): array
    {
        $headers = $b['headers'] ?? null;
        if (! is_array($headers) || ! array_is_list($headers) || count($headers) < 1 || count($headers) > 6) {
            $this->errors["{$p}.headers"][] = 'A table needs 1–6 columns.';

            return $b;
        }
        foreach ($headers as $i => $h) {
            $headers[$i] = $this->text($h, "{$p}.headers.{$i}", 0, 60);
        }
        $b['headers'] = $headers;

        $rows = $b['rows'] ?? null;
        if (! is_array($rows) || ! array_is_list($rows) || count($rows) < 1 || count($rows) > 50) {
            $this->errors["{$p}.rows"][] = 'A table needs 1–50 rows.';

            return $b;
        }
        foreach ($rows as $r => $row) {
            if (! is_array($row) || ! array_is_list($row) || count($row) !== count($headers)) {
                $this->errors["{$p}.rows.{$r}"][] = 'Each row needs exactly one cell per column.';

                continue;
            }
            foreach ($row as $c => $cell) {
                $rows[$r][$c] = $this->text($cell, "{$p}.rows.{$r}.{$c}", 0, 200);
            }
        }
        $b['rows'] = $rows;

        return $b;
    }

    /** Plain text: trimmed, length-limited, no control characters. */
    private function text(mixed $value, string $path, int $min, int $max): mixed
    {
        if (! is_string($value)) {
            $this->errors[$path][] = 'Must be text.';

            return $value;
        }
        $value = trim($value);
        if (preg_match('/[\x00-\x1F\x7F]/', $value) === 1) {
            $this->errors[$path][] = 'Control characters are not allowed.';
        } elseif (mb_strlen($value) < $min || mb_strlen($value) > $max) {
            $this->errors[$path][] = $min > 0 ? "Must be {$min}–{$max} characters." : "Must be at most {$max} characters.";
        }

        return $value;
    }

    /** @param list<array<string, mixed>> $body */
    private function checkMedia(array $body, string $path): void
    {
        $valid = Media::query()
            ->whereIn('id', array_values(array_unique($this->mediaIds)))
            ->where('purpose', 'page_image')
            ->where('status', '!=', Media::FAILED)
            ->pluck('id')->all();

        foreach ($body as $i => $block) {
            if (($block['type'] ?? null) === 'image' && $block['media_id'] !== null && ! in_array($block['media_id'], $valid, true)) {
                $this->errors["{$path}.{$i}.media_id"][] = 'Unknown image.';
            }
        }
    }

    /** @param array<string, list<string>> $errors */
    private function merge(array $errors): void
    {
        foreach ($errors as $k => $messages) {
            $this->errors[$k] = [...($this->errors[$k] ?? []), ...$messages];
        }
    }
}
