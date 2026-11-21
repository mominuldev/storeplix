<?php

namespace App\Domain\Themes;

use RuntimeException;

/**
 * Reads the theme registry, font allowlist, JSON Schemas and defaults from resources/themes/
 * (a byte-identical copy of packages/themes, checked by ThemeSchemaSyncTest).
 */
class ThemeRegistry
{
    public const STATUS_AVAILABLE = 'available';

    /** Fallback font allowlist (PHASE-3-CONTRACT §4.3) when fonts.json can't be read. */
    public const FONTS = ['Instrument Sans', 'Inter', 'Hind Siliguri', 'Fraunces', 'Noto Serif Bengali', 'Baloo Da 2'];

    /** @var array<string, mixed> */
    private array $cache = [];

    public function __construct(private readonly ?string $root = null) {}

    public function root(): string
    {
        return $this->root ?? resource_path('themes');
    }

    /** @return list<array<string, mixed>> ThemeCatalogEntry[] in registry order */
    public function catalog(): array
    {
        return $this->cache['catalog'] ??= array_values(array_map(
            fn (array $entry) => $this->entry($entry),
            array_filter($this->themesFromRegistry(), 'is_array'),
        ));
    }

    /** @return array<string, mixed>|null */
    public function find(string $code): ?array
    {
        foreach ($this->catalog() as $entry) {
            if ($entry['code'] === $code) {
                return $entry;
            }
        }

        return null;
    }

    /** Implemented = has a schema + defaults on disk. */
    public function isImplemented(string $code): bool
    {
        return preg_match('/^[a-z0-9-]{1,64}$/', $code) === 1
            && is_file($this->root()."/{$code}/defaults.json")
            && is_file($this->schemaPath($code, $this->major($code)));
    }

    public function isAvailable(string $code): bool
    {
        $entry = $this->find($code);

        return $entry !== null
            && $entry['status'] === self::STATUS_AVAILABLE
            && $entry['tier'] !== 'premium'
            && $this->isImplemented($code);
    }

    public function name(string $code): string
    {
        return (string) ($this->find($code)['name'] ?? $code);
    }

    public function version(string $code): string
    {
        $defaults = is_file($this->root()."/{$code}/defaults.json") ? $this->defaults($code) : [];

        return (string) ($this->find($code)['version'] ?? $defaults['version'] ?? '1.0.0');
    }

    public function major(string $code): int
    {
        return self::majorOf($this->version($code));
    }

    public static function majorOf(string $version): int
    {
        return (int) explode('.', $version)[0];
    }

    public function defaultCode(): string
    {
        return 'modern-commerce';
    }

    public function schemaPath(string $code, int $major): string
    {
        return $this->root()."/{$code}/schema.v{$major}.json";
    }

    /** Raw schema JSON string (opis loads it as an object). */
    public function schemaJson(string $code, int $major): string
    {
        $path = $this->schemaPath($code, $major);
        if (! is_file($path)) {
            throw new RuntimeException("No schema v{$major} for theme [{$code}].");
        }

        return $this->cache["schema:{$code}:{$major}"] ??= (string) file_get_contents($path);
    }

    /** @return array<string, mixed> complete, valid default config */
    public function defaults(string $code): array
    {
        return $this->cache["defaults:{$code}"] ??= $this->readJson("{$code}/defaults.json");
    }

    /** @return array<string, mixed> */
    public function manifest(string $code): array
    {
        $path = "{$code}/manifest.json";

        return $this->cache["manifest:{$code}"] ??= is_file($this->root().'/'.$path) ? $this->readJson($path) : [];
    }

    /** @return list<string> allowlisted font family names */
    public function fonts(): array
    {
        if (isset($this->cache['fonts'])) {
            return $this->cache['fonts'];
        }

        $names = [];
        if (is_file($this->root().'/fonts.json')) {
            $json = $this->readJson('fonts.json');
            $list = $json['fonts'] ?? $json['families'] ?? (array_is_list($json) ? $json : []);
            foreach ((array) $list as $key => $font) {
                $name = is_string($font) ? $font : ($font['family'] ?? $font['name'] ?? (is_string($key) ? $key : null));
                if (is_string($name) && $name !== '') {
                    $names[] = $name;
                }
            }
        }

        return $this->cache['fonts'] = $names !== [] ? array_values(array_unique($names)) : self::FONTS;
    }

    /**
     * maxInstances per section type: manifest first, contract table as fallback.
     *
     * @return array<string, int>
     */
    public function maxInstances(string $code): array
    {
        $limits = ThemeLimits::MAX_INSTANCES;
        foreach ($this->manifestSections($code) as $type => $section) {
            if (isset($section['maxInstances']) && is_int($section['maxInstances'])) {
                $limits[$type] = $section['maxInstances'];
            }
        }

        return $limits;
    }

    /** @return array<string, array<string, mixed>> keyed by section type */
    private function manifestSections(string $code): array
    {
        $sections = $this->manifest($code)['sections'] ?? [];
        $out = [];
        foreach (is_array($sections) ? $sections : [] as $key => $section) {
            if (! is_array($section)) {
                continue;
            }
            $type = $section['type'] ?? (is_string($key) ? $key : null);
            if (is_string($type)) {
                $out[$type] = $section;
            }
        }

        return $out;
    }

    /** @return list<array<string, mixed>> */
    private function themesFromRegistry(): array
    {
        if (! is_file($this->root().'/registry.json')) {
            return [];
        }
        $json = $this->readJson('registry.json');
        $list = array_is_list($json) ? $json : ($json['themes'] ?? []);

        return is_array($list) ? array_values($list) : [];
    }

    /**
     * @param  array<string, mixed>  $entry
     * @return array<string, mixed> ThemeCatalogEntry
     */
    private function entry(array $entry): array
    {
        $tier = ($entry['tier'] ?? 'free') === 'premium' ? 'premium' : 'free';

        return [
            'code' => (string) ($entry['code'] ?? ''),
            'name' => (string) ($entry['name'] ?? $entry['code'] ?? ''),
            'description' => (string) ($entry['description'] ?? ''),
            'version' => (string) ($entry['version'] ?? '1.0.0'),
            'status' => ($entry['status'] ?? 'coming_soon') === self::STATUS_AVAILABLE ? self::STATUS_AVAILABLE : 'coming_soon',
            'tier' => $tier,
            'price_amount' => $tier === 'premium' && is_int($entry['price_amount'] ?? null) ? $entry['price_amount'] : null,
            'currency' => $tier === 'premium' ? ($entry['currency'] ?? 'BDT') : null,
            'tags' => array_values(array_filter((array) ($entry['tags'] ?? []), 'is_string')),
            'is_new' => (bool) ($entry['is_new'] ?? false),
        ];
    }

    /** @return array<string, mixed> */
    private function readJson(string $relative): array
    {
        $path = $this->root().'/'.$relative;
        $data = json_decode((string) @file_get_contents($path), true);
        if (! is_array($data)) {
            throw new RuntimeException("Theme resource [{$relative}] is missing or not valid JSON.");
        }

        return $data;
    }
}
