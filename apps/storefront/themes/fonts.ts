/**
 * Allowlisted font families a merchant may pick. Values map to CSS variables created by
 * next/font in app/fonts.ts - merchants can never inject an arbitrary font-family string.
 */
export const FONT_STACKS = {
  'Instrument Sans': 'var(--font-instrument-sans), ui-sans-serif, system-ui, sans-serif',
  Inter: 'var(--font-inter), ui-sans-serif, system-ui, sans-serif',
  'Hind Siliguri': 'var(--font-hind-siliguri), ui-sans-serif, system-ui, sans-serif',
  Fraunces: 'var(--font-fraunces), ui-serif, Georgia, serif',
} as const;

export type FontFamilyName = keyof typeof FONT_STACKS;
export const FONT_NAMES = Object.keys(FONT_STACKS) as [FontFamilyName, ...FontFamilyName[]];
