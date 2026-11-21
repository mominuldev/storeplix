import type { CSSProperties } from 'react';
import { readableInk, sanitizeColor } from '@/lib/sanitize';
import { FONT_STACKS, type FontFamilyName } from './fonts';
import type { BaseThemeSettings } from './types';

const INK_LIGHT = '#fffcf8';
const INK_DARK = '#0e1a33';

/**
 * Merchant settings -> CSS custom properties for the root element. Values are re-sanitized here
 * (defence in depth) and passed as a React style object, so they are never concatenated into
 * CSS text. Derived tones (soft/strong/inverse) are computed in CSS with color-mix().
 */
export function themeCssVars(settings: BaseThemeSettings, defaults: BaseThemeSettings): CSSProperties {
  const brand = sanitizeColor(settings.primaryColor) ?? defaults.primaryColor;
  const accent = sanitizeColor(settings.secondaryColor) ?? defaults.secondaryColor;
  const body = FONT_STACKS[settings.fontFamily as FontFamilyName] ?? FONT_STACKS[defaults.fontFamily as FontFamilyName];
  const heading =
    FONT_STACKS[settings.headingFontFamily as FontFamilyName] ?? FONT_STACKS[defaults.headingFontFamily as FontFamilyName];

  return {
    '--sp-brand': brand,
    '--sp-on-brand': readableInk(brand, INK_LIGHT, INK_DARK),
    '--sp-accent': accent,
    '--sp-on-accent': readableInk(accent, INK_LIGHT, INK_DARK),
    '--sp-font-body': body,
    '--sp-font-heading': heading,
  } as CSSProperties;
}
