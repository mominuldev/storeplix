<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Pages\RichTextValidator;

/**
 * `HelpArticleDoc` (PHASE-8-9C P89C-5, S252): the PHASE-3 `RichTextDoc` subset plus `image` {media_id, alt, caption?}
 * and `callout` {tone} with paragraphs. Standard blocks are checked by the shared sanitizer (RichTextValidator, links
 * through SafeHref::richText — relative `/help/articles/{slug}` included; javascript:, data: and protocol-relative links
 * refused), each wrapped in a one-block doc whose error paths are re-keyed here. ≤ 200 blocks, ≤ 64 KB of JSON. Never
 * HTML: a body is a JSON object or it is refused.
 */
final class HelpArticleDocValidator
{
    public const MAX_BLOCKS = 200;

    public const MAX_BYTES = 65_536;

    public const TONES = ['info', 'warning', 'tip'];

    private const WRAP = '__help';

    /** @var array<string, list<string>> */
    private array $errors = [];

    /**
     * @param  (callable(string): bool)|null  $mediaKnown  true when an image id names an existing, not-failed help image
     * @return array<string, list<string>> errors keyed "{$path}.content.3…"
     */
    public static function validate(mixed $doc, string $path, ?callable $mediaKnown = null): array
    {
        $v = new self;
        $v->doc($doc, $path, $mediaKnown);

        return $v->errors;
    }

    private function doc(mixed $doc, string $path, ?callable $mediaKnown): void
    {
        if (! is_array($doc) || array_is_list($doc) || ($doc['type'] ?? null) !== 'doc' || array_diff(array_keys($doc), ['type', 'content']) !== []
            || ! array_key_exists('content', $doc)) {
            $this->fail($path, 'Must be a help article document.');

            return;
        }
        if (strlen((string) json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) > self::MAX_BYTES) {
            $this->fail($path, 'This article is too long (max 64 KB).');

            return;
        }
        $content = $doc['content'];
        if (! is_array($content) || ! array_is_list($content)) {
            $this->fail("{$path}.content", 'Must be a list.');

            return;
        }
        if (count($content) > self::MAX_BLOCKS) {
            $this->fail("{$path}.content", 'Must have between 0 and '.self::MAX_BLOCKS.' items.');

            return;
        }
        foreach ($content as $i => $block) {
            $blockPath = "{$path}.content.{$i}";
            $type = is_array($block) ? ($block['type'] ?? null) : null;
            match ($type) {
                'image' => $this->image($block, $blockPath, $mediaKnown),
                'callout' => $this->callout($block, $blockPath),
                default => $this->shared([$block], $blockPath, '.content.0'),
            };
        }
    }

    /** @param array<string, mixed> $node */
    private function image(array $node, string $path, ?callable $mediaKnown): void
    {
        if (! $this->keys($node, $path, ['type', 'attrs'], ['type', 'attrs'])) {
            return;
        }
        $attrs = $node['attrs'];
        if (! is_array($attrs) || ($attrs !== [] && array_is_list($attrs)) || ! $this->keys($attrs, "{$path}.attrs", ['media_id', 'alt', 'caption'], ['media_id', 'alt'])) {
            if (! is_array($attrs) || array_is_list($attrs)) {
                $this->fail("{$path}.attrs", 'Must be an object.');
            }

            return;
        }
        $id = $attrs['media_id'];
        if (! is_string($id) || preg_match('/^[0-9A-Za-z]{26}$/', $id) !== 1) {
            $this->fail("{$path}.attrs.media_id", 'Choose an uploaded image.');
        } elseif ($mediaKnown !== null && ! $mediaKnown(strtolower($id))) {
            $this->fail("{$path}.attrs.media_id", 'This image does not exist. Upload it again.');
        }
        if (! self::plain($attrs['alt'], 1, 200)) {
            $this->fail("{$path}.attrs.alt", 'Describe the image (1–200 characters).');
        }
        if (array_key_exists('caption', $attrs) && $attrs['caption'] !== null && ! self::plain($attrs['caption'], 0, 200)) {
            $this->fail("{$path}.attrs.caption", 'The caption may have at most 200 characters.');
        }
    }

    /** @param array<string, mixed> $node */
    private function callout(array $node, string $path): void
    {
        if (! $this->keys($node, $path, ['type', 'attrs', 'content'], ['type', 'attrs', 'content'])) {
            return;
        }
        $attrs = $node['attrs'];
        if (! is_array($attrs) || array_is_list($attrs) || array_keys($attrs) !== ['tone'] || ! in_array($attrs['tone'], self::TONES, true)) {
            $this->fail("{$path}.attrs.tone", 'Tone must be info, warning or tip.');
        }
        $content = $node['content'];
        if (! is_array($content) || ! array_is_list($content) || count($content) < 1 || count($content) > 10) {
            $this->fail("{$path}.content", 'Must have between 1 and 10 items.');

            return;
        }
        foreach ($content as $i => $p) {
            if (! is_array($p) || ($p['type'] ?? null) !== 'paragraph') {
                $this->fail("{$path}.content.{$i}", 'Only paragraphs are allowed here.');

                continue;
            }
            $this->shared([$p], "{$path}.content.{$i}", '.content.0');
        }
    }

    /**
     * Runs the shared sanitizer on a one-block doc and re-keys its errors onto $path.
     *
     * @param  list<mixed>  $blocks
     */
    private function shared(array $blocks, string $path, string $inner): void
    {
        $errors = RichTextValidator::validate(['type' => 'doc', 'content' => $blocks], self::WRAP, PHP_INT_MAX);
        $prefix = self::WRAP.$inner;
        foreach ($errors as $key => $messages) {
            $mapped = str_starts_with($key, $prefix) ? $path.substr($key, strlen($prefix)) : $path;
            foreach ($messages as $message) {
                $this->fail($mapped, $message);
            }
        }
    }

    /**
     * @param  array<mixed>  $value
     * @param  list<string>  $allowed
     * @param  list<string>  $required
     */
    private function keys(array $value, string $path, array $allowed, array $required): bool
    {
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

    private static function plain(mixed $value, int $min, int $max): bool
    {
        return is_string($value) && mb_strlen(trim($value)) >= $min && mb_strlen($value) <= $max
            && preg_match('/[\x00-\x1F\x7F]/', $value) !== 1 && mb_check_encoding($value, 'UTF-8');
    }

    private function fail(string $path, string $message): void
    {
        $this->errors[$path][] = $message;
    }
}
