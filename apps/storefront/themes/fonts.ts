/**
 * Allowlisted font families a merchant may pick (packages/themes/fonts.json). Values map to CSS
 * variables created by next/font in app/fonts.ts - merchants can never inject an arbitrary
 * font-family string. Bangla glyphs always fall back to Hind Siliguri.
 */
const BANGLA = 'var(--font-hind-siliguri)';

export const FONT_STACKS = {
  'Instrument Sans': `var(--font-instrument-sans), ${BANGLA}, ui-sans-serif, system-ui, sans-serif`,
  Inter: `var(--font-inter), ${BANGLA}, ui-sans-serif, system-ui, sans-serif`,
  'Hind Siliguri': `${BANGLA}, ui-sans-serif, system-ui, sans-serif`,
  Fraunces: `var(--font-fraunces), ${BANGLA}, ui-serif, Georgia, serif`,
  'Noto Serif Bengali': `var(--font-noto-serif-bengali), ${BANGLA}, ui-serif, Georgia, serif`,
  'Baloo Da 2': `var(--font-baloo-da-2), ${BANGLA}, ui-rounded, system-ui, sans-serif`,
} as const;

export type FontFamilyName = keyof typeof FONT_STACKS;
export const FONT_NAMES = Object.keys(FONT_STACKS) as [FontFamilyName, ...FontFamilyName[]];
