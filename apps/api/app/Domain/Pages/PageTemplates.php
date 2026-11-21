<?php

namespace App\Domain\Pages;

use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Themes\ThemeConfigUpgrader;
use RuntimeException;

/** Server-defined page templates (resources/page-templates/*.json, PHASE-3-CONTRACT §4.6). */
class PageTemplates
{
    public const CODES = ['blank', 'about', 'contact', 'faq', 'size_guide', 'how_to_order', 'wholesale', 'privacy', 'terms', 'returns'];

    /** @var array<string, array<string, mixed>> */
    private array $cache = [];

    /** @return list<array<string, mixed>> PageTemplate[] */
    public function all(): array
    {
        return array_map(fn (string $code) => $this->public($this->load($code)), self::CODES);
    }

    /**
     * Title, slug and body for a new page, with shop details filled in as plain text. Sentences whose
     * placeholder has no value are omitted.
     *
     * @return array{title: string, slug: string|null, body: list<array<string, mixed>>}
     */
    public function build(string $code, Store $store, ?StoreSetting $settings): array
    {
        $template = $this->load($code);
        $values = [
            '{store_name}' => $store->name,
            '{store_phone}' => $settings?->contact_phone,
            '{store_email}' => $settings?->contact_email,
            '{support_hours}' => $settings?->support_hours,
        ];

        $body = [];
        foreach ($template['body'] as $block) {
            $block['id'] = ThemeConfigUpgrader::randomId();
            $block = $this->fillBlock($block, $values);
            if ($block !== null) {
                $body[] = $block;
            }
        }

        return ['title' => (string) $template['default_title'], 'slug' => $template['default_slug'], 'body' => $body];
    }

    /**
     * @param  array<string, mixed>  $block
     * @param  array<string, string|null>  $values
     * @return array<string, mixed>|null
     */
    private function fillBlock(array $block, array $values): ?array
    {
        switch ($block['type']) {
            case 'heading':
                $block['text'] = $this->fill($block['text'], $values);

                return $block['text'] === '' ? null : $block;
            case 'rich_text':
                $paragraphs = [];
                foreach ($block['doc']['content'] as $node) {
                    $node = $this->fillNode($node, $values);
                    if ($node !== null) {
                        $paragraphs[] = $node;
                    }
                }
                $block['doc']['content'] = $paragraphs;

                return $paragraphs === [] ? null : $block;
            case 'callout':
                $block['items'] = array_values(array_filter(array_map(fn ($i) => $this->fill($i, $values), $block['items']), fn ($i) => $i !== ''));
                $block['title'] = $block['title'] === null ? null : ($this->fill($block['title'], $values) ?: null);

                return $block['items'] === [] ? null : $block;
            case 'table':
                $block['rows'] = array_map(fn ($row) => array_map(fn ($c) => $this->fill($c, $values), $row), $block['rows']);

                return $block;
            default:
                return $block;
        }
    }

    /** @param array<string, string|null> $values */
    private function fillNode(array $node, array $values): ?array
    {
        if (($node['type'] ?? null) === 'text') {
            $node['text'] = $this->fill($node['text'], $values);

            return $node['text'] === '' ? null : $node;
        }
        if (isset($node['content']) && is_array($node['content'])) {
            $node['content'] = array_values(array_filter(array_map(fn ($n) => $this->fillNode($n, $values), $node['content'])));
            if ($node['content'] === [] && $node['type'] === 'paragraph') {
                return null;
            }
        }

        return $node;
    }

    /** @param array<string, string|null> $values */
    private function fill(string $text, array $values): string
    {
        if (! str_contains($text, '{')) {
            return $text;
        }

        $sentences = preg_split('/(?<=[.!?।])\s+/u', $text) ?: [$text];
        $kept = [];
        foreach ($sentences as $sentence) {
            foreach ($values as $placeholder => $value) {
                if (str_contains($sentence, $placeholder)) {
                    if ($value === null || trim($value) === '') {
                        continue 2;
                    }
                    // Plain text only, never markup; strip control chars from merchant values.
                    $sentence = str_replace($placeholder, trim((string) preg_replace('/[\x00-\x1F\x7F]+/', ' ', $value)), $sentence);
                }
            }
            $kept[] = $sentence;
        }

        return trim(implode(' ', $kept));
    }

    /** @return array<string, mixed> */
    private function load(string $code): array
    {
        if (! in_array($code, self::CODES, true)) {
            throw new RuntimeException("Unknown page template [{$code}].");
        }

        return $this->cache[$code] ??= json_decode((string) file_get_contents(resource_path("page-templates/{$code}.json")), true, 512, JSON_THROW_ON_ERROR);
    }

    /**
     * @param  array<string, mixed>  $template
     * @return array<string, mixed>
     */
    private function public(array $template): array
    {
        return [
            'code' => $template['code'],
            'name' => $template['name'],
            'description' => $template['description'],
            'category' => $template['category'],
            'default_title' => $template['default_title'],
            'default_slug' => $template['default_slug'],
            'highlights' => $template['highlights'],
        ];
    }
}
