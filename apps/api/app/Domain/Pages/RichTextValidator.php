<?php

namespace App\Domain\Pages;

use App\Domain\Themes\SafeHref;

/**
 * Validates a RichTextDoc (PHASE-3-CONTRACT §4.4): a strict subset of ProseMirror/Tiptap JSON. Never HTML.
 * Unknown node/mark types, unknown keys and extra attrs are errors. Link hrefs go through SafeHref::richText().
 */
final class RichTextValidator
{
    private const BLOCKS = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'];

    private const SIMPLE_MARKS = ['bold', 'italic', 'underline', 'strike'];

    /** @var array<string, list<string>> */
    private array $errors = [];

    /**
     * @return array<string, list<string>> errors keyed by "{$path}.content.0…"
     */
    public static function validate(mixed $doc, string $path, int $maxBytes): array
    {
        $v = new self;
        $v->doc($doc, $path, $maxBytes);

        return $v->errors;
    }

    private function doc(mixed $doc, string $path, int $maxBytes): void
    {
        if (! $this->object($doc, $path, ['type', 'content'], ['type', 'content']) || $doc['type'] !== 'doc') {
            $this->errors[$path] ??= ['Must be a rich text document.'];

            return;
        }

        if (strlen((string) json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) > $maxBytes) {
            $this->fail($path, 'This text is too long (max '.intdiv($maxBytes, 1024).' KB).');

            return;
        }

        if (! $this->list($doc['content'], "{$path}.content", 0, 100)) {
            return;
        }

        foreach ($doc['content'] as $i => $block) {
            $this->block($block, "{$path}.content.{$i}");
        }
    }

    private function block(mixed $node, string $path): void
    {
        if (! is_array($node) || ! is_string($node['type'] ?? null) || ! in_array($node['type'], self::BLOCKS, true)) {
            $this->fail($path, 'Unsupported block.');

            return;
        }

        match ($node['type']) {
            'paragraph' => $this->textContainer($node, $path, ['type', 'content'], ['type']),
            'heading' => $this->heading($node, $path),
            'bulletList', 'orderedList' => $this->listNode($node, $path),
            'blockquote' => $this->paragraphs($node, $path, 1, 10),
        };
    }

    private function heading(array $node, string $path): void
    {
        if (! $this->textContainer($node, $path, ['type', 'attrs', 'content'], ['type', 'attrs'])) {
            return;
        }
        if ($this->object($node['attrs'], "{$path}.attrs", ['level'], ['level'])
            && ! in_array($node['attrs']['level'], [2, 3], true)) {
            $this->fail("{$path}.attrs.level", 'Heading level must be 2 or 3.');
        }
    }

    private function listNode(array $node, string $path): void
    {
        if (! $this->object($node, $path, ['type', 'content'], ['type', 'content'])
            || ! $this->list($node['content'], "{$path}.content", 1, 50)) {
            return;
        }

        foreach ($node['content'] as $i => $item) {
            $itemPath = "{$path}.content.{$i}";
            if (! is_array($item) || ($item['type'] ?? null) !== 'listItem') {
                $this->fail($itemPath, 'Lists may only contain list items.');

                continue;
            }
            $this->paragraphs($item, $itemPath, 1, 5);
        }
    }

    private function paragraphs(array $node, string $path, int $min, int $max): void
    {
        if (! $this->object($node, $path, ['type', 'content'], ['type', 'content'])
            || ! $this->list($node['content'], "{$path}.content", $min, $max)) {
            return;
        }

        foreach ($node['content'] as $i => $p) {
            if (! is_array($p) || ($p['type'] ?? null) !== 'paragraph') {
                $this->fail("{$path}.content.{$i}", 'Only paragraphs are allowed here.');

                continue;
            }
            $this->textContainer($p, "{$path}.content.{$i}", ['type', 'content'], ['type']);
        }
    }

    /**
     * @param  list<string>  $allowed
     * @param  list<string>  $required
     */
    private function textContainer(array $node, string $path, array $allowed, array $required): bool
    {
        if (! $this->object($node, $path, $allowed, $required)) {
            return false;
        }
        if (! array_key_exists('content', $node)) {
            return true;
        }
        if (! $this->list($node['content'], "{$path}.content", 0, 5000)) {
            return false;
        }

        foreach ($node['content'] as $i => $inline) {
            $this->inline($inline, "{$path}.content.{$i}");
        }

        return true;
    }

    private function inline(mixed $node, string $path): void
    {
        $type = is_array($node) ? ($node['type'] ?? null) : null;

        if ($type === 'hardBreak') {
            $this->object($node, $path, ['type'], ['type']);

            return;
        }

        if ($type !== 'text') {
            $this->fail($path, 'Unsupported inline content.');

            return;
        }

        if (! $this->object($node, $path, ['type', 'text', 'marks'], ['type', 'text'])) {
            return;
        }

        $text = $node['text'];
        if (! is_string($text) || $text === '' || mb_strlen($text) > 5000 || preg_match('/[\x00-\x1F\x7F]/', $text) === 1) {
            $this->fail("{$path}.text", 'Text must be 1–5000 characters without control characters.');
        }

        if (! array_key_exists('marks', $node)) {
            return;
        }
        if (! $this->list($node['marks'], "{$path}.marks", 0, 10)) {
            return;
        }

        foreach ($node['marks'] as $i => $mark) {
            $markPath = "{$path}.marks.{$i}";
            $markType = is_array($mark) ? ($mark['type'] ?? null) : null;

            if (in_array($markType, self::SIMPLE_MARKS, true)) {
                $this->object($mark, $markPath, ['type'], ['type']);
            } elseif ($markType === 'link') {
                if ($this->object($mark, $markPath, ['type', 'attrs'], ['type', 'attrs'])
                    && $this->object($mark['attrs'], "{$markPath}.attrs", ['href'], ['href'])
                    && ! SafeHref::richText($mark['attrs']['href'])) {
                    $this->fail("{$markPath}.attrs.href", 'This link is not allowed.');
                }
            } else {
                $this->fail($markPath, 'Unsupported text style.');
            }
        }
    }

    /**
     * Associative array with only $allowed keys and all $required keys.
     *
     * @param  list<string>  $allowed
     * @param  list<string>  $required
     */
    private function object(mixed $value, string $path, array $allowed, array $required): bool
    {
        if (! is_array($value) || ($value !== [] && array_is_list($value))) {
            $this->fail($path, 'Must be an object.');

            return false;
        }

        $ok = true;
        foreach (array_keys($value) as $key) {
            if (! in_array($key, $allowed, true)) {
                $this->fail("{$path}.{$key}", 'Unknown field.');
                $ok = false;
            }
        }
        foreach ($required as $key) {
            if (! array_key_exists($key, $value)) {
                $this->fail("{$path}.{$key}", 'This field is required.');
                $ok = false;
            }
        }

        return $ok;
    }

    private function list(mixed $value, string $path, int $min, int $max): bool
    {
        if (! is_array($value) || ! array_is_list($value)) {
            $this->fail($path, 'Must be a list.');

            return false;
        }
        if (count($value) < $min || count($value) > $max) {
            $this->fail($path, "Must have between {$min} and {$max} items.");

            return false;
        }

        return true;
    }

    private function fail(string $path, string $message): void
    {
        $this->errors[$path][] = $message;
    }
}
