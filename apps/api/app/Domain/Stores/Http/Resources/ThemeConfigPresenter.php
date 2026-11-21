<?php

namespace App\Domain\Stores\Http\Resources;

/**
 * Shapes stored theme JSON into ThemeConfig (camelCase keys inside settings are part of the
 * theme schema, not API field names, and are passed through as-is).
 */
final class ThemeConfigPresenter
{
    /**
     * @param  array<string, mixed>  $theme
     * @return array<string, mixed>
     */
    public static function present(array $theme): array
    {
        $default = config('storeplix.default_theme');

        $sections = array_values(array_map(static function ($section): array {
            $out = ['type' => (string) ($section['type'] ?? ''), 'enabled' => (bool) ($section['enabled'] ?? false)];
            if (isset($section['settings']) && is_array($section['settings'])) {
                $out['settings'] = (object) $section['settings'];
            }

            return $out;
        }, is_array($theme['sections'] ?? null) ? $theme['sections'] : []));

        return [
            'theme' => (string) ($theme['theme'] ?? $default['theme']),
            'version' => (string) ($theme['version'] ?? $default['version']),
            'settings' => (object) array_merge($default['settings'], is_array($theme['settings'] ?? null) ? $theme['settings'] : []),
            'sections' => $sections,
        ];
    }
}
