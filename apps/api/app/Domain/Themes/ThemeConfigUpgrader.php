<?php

namespace App\Domain\Themes;

/**
 * Upgrades a stored (Phase 1/2, 1.0.x) modern-commerce config to 1.1.0 (PHASE-3-CONTRACT §2). Pure PHP:
 * no models, no DB. Unknown section types and keys are dropped, every section/block gets an id, missing global
 * settings and required section settings come from defaults.json. Image URL fields (P3-12) are dropped.
 */
class ThemeConfigUpgrader
{
    public const VERSION = '1.1.0';

    /** Section settings keys per type (contract §4.3). */
    public const SECTION_KEYS = [
        'hero' => ['eyebrow', 'heading', 'headingAccent', 'subheading', 'primaryCtaLabel', 'primaryCtaHref', 'secondaryCtaLabel',
            'secondaryCtaHref', 'imageMediaId', 'imageAlt', 'detailImageMediaId', 'tagLabel', 'showFeaturedProduct', 'layout', 'height', 'design'],
        'chip-links' => ['title', 'subtitle', 'design'],
        'flash-sale' => ['eyebrow', 'title', 'subtitle', 'endsAt', 'linkLabel', 'linkHref', 'limit', 'design'],
        'category-grid' => ['title', 'subtitle', 'design'],
        'featured-products' => ['eyebrow', 'title', 'linkLabel', 'linkHref', 'source', 'limit', 'design'],
        'image-with-text' => ['eyebrow', 'heading', 'text', 'ctaLabel', 'ctaHref', 'imageMediaId', 'imageAlt', 'layout', 'design'],
        'feature-tiles' => ['title', 'subtitle', 'design'],
        'trust-badges' => ['design'],
        'reviews-club' => ['title', 'subtitle', 'club', 'design'],
        'rich-text' => ['heading', 'doc', 'align', 'width', 'design'],
    ];

    /** Payment badge labels used by the 1.0 storefront → 1.1 codes. */
    private const PAYMENT_CODES = [
        'cash on delivery' => 'cod', 'cod' => 'cod', 'bkash' => 'bkash', 'nagad' => 'nagad', 'rocket' => 'rocket',
        'upay' => 'upay', 'visa' => 'visa', 'mastercard' => 'mastercard', 'amex' => 'amex', 'american express' => 'amex',
    ];

    public function __construct(private readonly ThemeRegistry $registry) {}

    /**
     * @param  array<string, mixed>  $old
     * @return array<string, mixed>
     */
    public function toV1_1(array $old): array
    {
        $defaults = $this->registry->defaults('modern-commerce');
        $fonts = $this->registry->fonts();
        $oldSettings = is_array($old['settings'] ?? null) ? $old['settings'] : [];

        $settings = $defaults['settings'];
        foreach (['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor'] as $key) {
            $value = is_string($oldSettings[$key] ?? null) ? strtolower(trim($oldSettings[$key])) : null;
            if ($value !== null && preg_match('/^#[0-9a-f]{6}$/', $value) === 1) {
                $settings[$key] = $value;
            }
        }
        foreach (['fontFamily', 'headingFontFamily'] as $key) {
            if (is_string($oldSettings[$key] ?? null) && in_array($oldSettings[$key], $fonts, true)) {
                $settings[$key] = $oldSettings[$key];
            }
        }
        foreach (['cornerStyle' => ['square', 'rounded', 'pill'], 'buttonStyle' => ['solid', 'outline']] as $key => $allowed) {
            if (in_array($oldSettings[$key] ?? null, $allowed, true)) {
                $settings[$key] = $oldSettings[$key];
            }
        }

        // 1.0 flat fields → 1.1 groups.
        if (is_string($oldSettings['announcement'] ?? null) && ($text = $this->text($oldSettings['announcement'], 120)) !== null && $text !== '') {
            $settings['announcement']['text'] = $text;
        }
        $promo = $oldSettings['promoLink'] ?? null;
        if (is_array($promo) && ($label = $this->text($promo['label'] ?? null, 30)) && SafeHref::theme($promo['href'] ?? null)) {
            $settings['header']['promoLink'] = ['label' => $label, 'href' => $promo['href']];
        }
        if (array_key_exists('footerTagline', $oldSettings)) {
            $settings['footer']['tagline'] = $this->text($oldSettings['footerTagline'], 240) ?: null;
        }
        if (is_array($oldSettings['paymentMethods'] ?? null)) {
            $codes = [];
            foreach ($oldSettings['paymentMethods'] as $label) {
                $code = is_string($label) ? (self::PAYMENT_CODES[strtolower(trim($label))] ?? null) : null;
                if ($code !== null && ! in_array($code, $codes, true)) {
                    $codes[] = $code;
                }
            }
            if ($codes !== []) {
                $settings['footer']['paymentMethods'] = array_slice($codes, 0, 8);
            }
        }

        // Phase 1/2 had no section editor: a 1.0 section list without any section settings is the untouched
        // platform default, not merchant content, so it is treated like "empty" and gets the 1.1 default home.
        $oldSections = is_array($old['sections'] ?? null) ? $old['sections'] : [];
        $untouched = $oldSections !== [] && ! str_starts_with((string) ($old['version'] ?? '1.0'), '1.1')
            && array_filter($oldSections, fn ($s) => is_array($s) && ! empty($s['settings'])) === [];
        $sections = $untouched ? [] : $this->sections($oldSections, $defaults);

        $config = [
            'theme' => 'modern-commerce',
            'version' => self::VERSION,
            'settings' => $settings,
            'sections' => $sections === [] ? $this->withFreshIds($defaults['sections']) : $sections,
        ];

        return $this->repair($config, $defaults);
    }

    /**
     * Old values the schema rejects (too long, bad enum…) fall back to the default value of that key.
     * Anything still invalid after a few passes → defaults with the carried-over brand colours and fonts.
     *
     * @param  array<string, mixed>  $config
     * @param  array<string, mixed>  $defaults
     * @return array<string, mixed>
     */
    private function repair(array $config, array $defaults): array
    {
        $validator = new ThemeConfigValidator($this->registry);
        $defaultByType = [];
        foreach ($defaults['sections'] as $section) {
            $defaultByType[$section['type']] ??= $section;
        }

        for ($pass = 0; $pass < 3; $pass++) {
            $errors = $validator->schemaErrorsFor('modern-commerce', $config);
            if ($errors === []) {
                return $config;
            }

            foreach (array_keys($errors) as $path) {
                $parts = explode('.', $path);
                if (($parts[1] ?? null) === 'settings' && isset($parts[2])) {
                    $config['settings'][$parts[2]] = $defaults['settings'][$parts[2]] ?? null;
                } elseif (($parts[1] ?? null) === 'sections' && isset($parts[2]) && is_numeric($parts[2])) {
                    $i = (int) $parts[2];
                    $base = $defaultByType[$config['sections'][$i]['type'] ?? ''] ?? null;
                    if ($base === null) {
                        continue;
                    }
                    if (($parts[3] ?? null) === 'settings' && isset($parts[4])) {
                        if (array_key_exists($parts[4], $base['settings'] ?? [])) {
                            $config['sections'][$i]['settings'][$parts[4]] = $base['settings'][$parts[4]];
                        } else {
                            unset($config['sections'][$i]['settings'][$parts[4]]);
                        }
                    } elseif (($parts[3] ?? null) === 'blocks' && array_key_exists('blocks', $base)) {
                        $ids = [];
                        $config['sections'][$i]['blocks'] = $this->blocksWithFreshIds($base['blocks'], $ids);
                    }
                }
            }
        }

        if ($validator->schemaErrorsFor('modern-commerce', $config) === []) {
            return $config;
        }

        $fallback = $defaults;
        foreach (['primaryColor', 'secondaryColor', 'textColor', 'backgroundColor', 'fontFamily', 'headingFontFamily'] as $key) {
            $fallback['settings'][$key] = $config['settings'][$key] ?? $fallback['settings'][$key];
        }
        $fallback['sections'] = $this->withFreshIds($defaults['sections']);

        return $fallback;
    }

    /**
     * @param  array<mixed>  $old
     * @param  array<string, mixed>  $defaults
     * @return list<array<string, mixed>>
     */
    private function sections(array $old, array $defaults): array
    {
        $defaultByType = [];
        foreach ($defaults['sections'] as $section) {
            $defaultByType[$section['type']] ??= $section;
        }

        $out = [];
        $count = [];
        $ids = [];
        foreach (array_values($old) as $section) {
            $type = is_array($section) ? ($section['type'] ?? null) : null;
            if (! is_string($type) || ! isset(self::SECTION_KEYS[$type], $defaultByType[$type])) {
                continue; // unknown or undesigned type
            }
            $count[$type] = ($count[$type] ?? 0) + 1;
            if ($count[$type] > (ThemeLimits::MAX_INSTANCES[$type] ?? 1) || count($out) >= ThemeLimits::MAX_SECTIONS) {
                continue;
            }

            $base = $defaultByType[$type];
            $oldSettings = is_array($section['settings'] ?? null) ? $section['settings'] : [];
            $kept = array_intersect_key($oldSettings, array_flip(self::SECTION_KEYS[$type]));
            $kept = array_filter($kept, fn ($v, $k) => $this->keepValue($k, $v, $base['settings'][$k] ?? null), ARRAY_FILTER_USE_BOTH);

            $upgraded = [
                'id' => $this->id($section['id'] ?? null, $ids),
                'type' => $type,
                'enabled' => is_bool($section['enabled'] ?? null) ? $section['enabled'] : true,
                'settings' => array_merge(is_array($base['settings'] ?? null) ? $base['settings'] : [], $kept),
            ];

            if (array_key_exists('blocks', $base)) {
                $blocks = $type === 'hero' ? $this->heroStats($oldSettings['stats'] ?? null, $ids) : [];
                $upgraded['blocks'] = $blocks !== [] ? $blocks : $this->blocksWithFreshIds($base['blocks'], $ids);
            }

            $out[] = $upgraded;
        }

        return $out;
    }

    /** Keep only scalar values whose type matches the default's (strings trimmed and length-checked later by the schema). */
    private function keepValue(string $key, mixed $value, mixed $default): bool
    {
        if (str_ends_with($key, 'Href')) {
            return $value === null || SafeHref::theme($value);
        }
        if ($default === null) {
            return $value === null || is_string($value);
        }

        return get_debug_type($value) === get_debug_type($default) && ! is_array($value);
    }

    /**
     * @param  array<string, true>  $ids
     * @return list<array<string, mixed>>
     */
    private function heroStats(mixed $stats, array &$ids): array
    {
        $blocks = [];
        foreach (is_array($stats) ? $stats : [] as $stat) {
            $value = is_array($stat) ? $this->text($stat['value'] ?? null, 12) : null;
            $label = is_array($stat) ? $this->text($stat['label'] ?? null, 40) : null;
            if ($value && $label && count($blocks) < 3) {
                $blocks[] = ['id' => $this->id(null, $ids), 'type' => 'stat', 'settings' => ['value' => $value, 'label' => $label]];
            }
        }

        return $blocks;
    }

    /**
     * @param  list<array<string, mixed>>  $sections
     * @return list<array<string, mixed>>
     */
    private function withFreshIds(array $sections): array
    {
        $ids = [];
        foreach ($sections as $i => $section) {
            $sections[$i]['id'] = $this->id($section['id'] ?? null, $ids);
            if (isset($section['blocks'])) {
                $sections[$i]['blocks'] = $this->blocksWithFreshIds($section['blocks'], $ids);
            }
        }

        return $sections;
    }

    /**
     * @param  list<array<string, mixed>>  $blocks
     * @param  array<string, true>  $ids
     * @return list<array<string, mixed>>
     */
    private function blocksWithFreshIds(array $blocks, array &$ids): array
    {
        foreach ($blocks as $i => $block) {
            $blocks[$i]['id'] = $this->id($block['id'] ?? null, $ids);
        }

        return $blocks;
    }

    /** Keeps a valid unused id, else generates one (10 chars [a-z0-9]). */
    private function id(mixed $candidate, array &$ids): string
    {
        $id = is_string($candidate) && preg_match('/^[a-z0-9]{8,16}$/', $candidate) === 1 && ! isset($ids[$candidate])
            ? $candidate
            : null;
        while ($id === null || isset($ids[$id])) {
            $id = self::randomId();
        }
        $ids[$id] = true;

        return $id;
    }

    public static function randomId(int $length = 10): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        $id = '';
        for ($i = 0; $i < $length; $i++) {
            $id .= $alphabet[random_int(0, 35)];
        }

        return $id;
    }

    private function text(mixed $value, int $max): ?string
    {
        if (! is_string($value)) {
            return null;
        }
        $value = trim(preg_replace('/[\x00-\x1F\x7F]+/', ' ', $value) ?? '');

        return mb_strlen($value) <= $max ? $value : null;
    }
}
