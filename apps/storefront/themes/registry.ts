import type { BaseThemeSettings, ResolvedThemeConfig, ThemeDefinition } from './types';
import { resolveThemeConfig } from './resolve';
import { modernCommerce } from './modern-commerce';

/**
 * Theme registry: theme id -> definition (version, Zod config schema, layout, section components).
 * Add a theme by implementing ThemeDefinition and registering it here. Themes are code we ship;
 * merchants only supply validated JSON config, never JS/HTML.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const themeRegistry: Record<string, ThemeDefinition<any>> = {
  [modernCommerce.id]: modernCommerce,
};

export const DEFAULT_THEME_ID = modernCommerce.id;

export function getTheme(id: unknown): ThemeDefinition<BaseThemeSettings> | undefined {
  return typeof id === 'string' && Object.hasOwn(themeRegistry, id) ? themeRegistry[id] : undefined;
}

/** Pick the merchant's theme (or the default) and validate its config. Never throws. */
export function resolveStoreTheme(rawTheme: unknown): {
  theme: ThemeDefinition<BaseThemeSettings>;
  config: ResolvedThemeConfig;
} {
  const requestedId =
    typeof rawTheme === 'object' && rawTheme !== null ? (rawTheme as { theme?: unknown }).theme : undefined;
  const theme = getTheme(requestedId) ?? themeRegistry[DEFAULT_THEME_ID]!;
  return { theme, config: resolveThemeConfig(theme, rawTheme) };
}

/** Default (all-fallback) settings for a theme, used to backstop CSS variables. */
export function defaultSettings(theme: ThemeDefinition<BaseThemeSettings>): BaseThemeSettings {
  return theme.settingsSchema.parse({});
}
