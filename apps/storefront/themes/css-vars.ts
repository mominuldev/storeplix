import type { CSSProperties } from 'react';
import { readableInk, sanitizeHex } from '@/lib/sanitize';
import { FONT_STACKS, type FontFamilyName } from './fonts';
import type { BaseThemeSettings, CornerStyle } from './types';

const INK_LIGHT = '#fffcf8';
const INK_DARK = '#0e1a33';

/** Figma values for the default ink/canvas; derived tones are used only when the merchant changes them. */
const DEFAULT_INK = { ink: '#0e1a33', secondary: '#33405c', muted: '#66728c' };
const DEFAULT_CANVAS = { canvas: '#fffcf8', sunken: '#faf5ee' };

const RADIUS: Record<CornerStyle, string> = { square: '4px', rounded: '10px', pill: '999px' };

/**
 * Merchant settings -> CSS custom properties for the root element. Values are re-sanitized here
 * (defence in depth: hex only, closed font/corner lists) and passed as a React style object, so they
 * are never concatenated into CSS text. Derived tones (soft/strong/inverse) are computed in CSS.
 */
export function themeCssVars(settings: BaseThemeSettings, defaults: BaseThemeSettings): CSSProperties {
  const brand = sanitizeHex(settings.primaryColor) ?? defaults.primaryColor;
  const accent = sanitizeHex(settings.secondaryColor) ?? defaults.secondaryColor;
  const ink = sanitizeHex(settings.textColor) ?? defaults.textColor;
  const canvas = sanitizeHex(settings.backgroundColor) ?? defaults.backgroundColor;
  const body = FONT_STACKS[settings.fontFamily as FontFamilyName] ?? FONT_STACKS[defaults.fontFamily as FontFamilyName];
  const heading =
    FONT_STACKS[settings.headingFontFamily as FontFamilyName] ?? FONT_STACKS[defaults.headingFontFamily as FontFamilyName];
  const radius = RADIUS[settings.cornerStyle] ?? RADIUS[defaults.cornerStyle] ?? RADIUS.pill;

  const inkVars =
    ink === DEFAULT_INK.ink
      ? { secondary: DEFAULT_INK.secondary, muted: DEFAULT_INK.muted }
      : { secondary: `color-mix(in srgb, ${ink} 82%, ${canvas})`, muted: `color-mix(in srgb, ${ink} 64%, ${canvas})` };
  const sunken = canvas === DEFAULT_CANVAS.canvas ? DEFAULT_CANVAS.sunken : `color-mix(in srgb, ${canvas} 95%, ${ink})`;

  return {
    '--sp-brand': brand,
    '--sp-on-brand': readableInk(brand, INK_LIGHT, INK_DARK),
    '--sp-accent': accent,
    '--sp-on-accent': readableInk(accent, INK_LIGHT, INK_DARK),
    '--sp-ink': ink,
    '--sp-ink-secondary': inkVars.secondary,
    '--sp-ink-muted': inkVars.muted,
    '--sp-canvas': canvas,
    '--sp-sunken': sunken,
    '--sp-radius-control': radius,
    '--sp-font-body': body,
    '--sp-font-heading': heading,
  } as CSSProperties;
}
