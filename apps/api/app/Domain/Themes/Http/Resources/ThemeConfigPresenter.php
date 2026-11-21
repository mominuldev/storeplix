<?php

namespace App\Domain\Themes\Http\Resources;

/**
 * Passes the camelCase theme document through untransformed (P3-4); only restores JSON objects that PHP
 * decoded to empty arrays (`settings: {}`), so the dashboard can re-save what it reads.
 */
final class ThemeConfigPresenter
{
    /**
     * @param  array<string, mixed>  $config
     * @return array<string, mixed>
     */
    public static function present(array $config): array
    {
        $config['settings'] = (object) ($config['settings'] ?? []);
        $config['sections'] = array_values(array_map(static function ($section) {
            if (! is_array($section)) {
                return $section;
            }
            if (array_key_exists('settings', $section)) {
                $section['settings'] = self::objects($section['settings']);
            }
            if (isset($section['blocks']) && is_array($section['blocks'])) {
                $section['blocks'] = array_values(array_map(static function ($block) {
                    if (is_array($block) && array_key_exists('settings', $block)) {
                        $block['settings'] = self::objects($block['settings']);
                    }

                    return $block;
                }, $section['blocks']));
            }

            return $section;
        }, is_array($config['sections'] ?? null) ? $config['sections'] : []));

        return $config;
    }

    private static function objects(mixed $settings): mixed
    {
        return is_array($settings) && ($settings === [] || ! array_is_list($settings)) ? (object) $settings : $settings;
    }
}
