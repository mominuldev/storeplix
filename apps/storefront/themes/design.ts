import type { CSSProperties } from 'react';
import { z } from 'zod';
import { readableInk, sanitizeHex } from '@/lib/sanitize';
import { boolField, enumField, field, intField, isPlainObject, markFallback } from './schema-helpers';

/**
 * Common section "Design" settings (PHASE-3-CONTRACT §4.3, V3 Design tab). Values reach CSS only as
 * React style custom properties built from closed lists or a sanitized hex - never as CSS text.
 */
export interface SectionDesign {
  background: 'default' | 'muted' | 'brand' | 'accent' | 'inverse' | 'custom';
  customBackground: string | null;
  textTone: 'auto' | 'dark' | 'light';
  paddingTop: number;
  paddingBottom: number;
  visibility: { desktop: boolean; tablet: boolean; phone: boolean };
}

export const DEFAULT_DESIGN: SectionDesign = {
  background: 'default',
  customBackground: null,
  textTone: 'auto',
  paddingTop: 48,
  paddingBottom: 48,
  visibility: { desktop: true, tablet: true, phone: true },
};

const BACKGROUNDS = ['default', 'muted', 'brand', 'accent', 'inverse', 'custom'] as const;

/** Self-healing design schema. `def` is the section type's default design (from defaults.json). */
export function designSchema(def: SectionDesign = DEFAULT_DESIGN) {
  const shape = z.object({
    background: enumField(BACKGROUNDS, def.background),
    customBackground: field<string | null>((v) => (v === null ? null : (sanitizeHex(v) ?? undefined)), def.customBackground),
    textTone: enumField(['auto', 'dark', 'light'] as const, def.textTone),
    paddingTop: intField(def.paddingTop, 0, 160, 8),
    paddingBottom: intField(def.paddingBottom, 0, 160, 8),
    visibility: z.preprocess(
      (v) => {
        if (isPlainObject(v)) return v;
        if (v !== undefined) markFallback();
        return {};
      },
      z.object({
        desktop: boolField(def.visibility.desktop),
        tablet: boolField(def.visibility.tablet),
        phone: boolField(def.visibility.phone),
      }),
    ),
  });
  return z
    .preprocess((v) => {
      if (isPlainObject(v)) return v;
      if (v !== undefined) markFallback();
      return {};
    }, shape)
    .transform((d): SectionDesign => {
      // customBackground is required (non-null) iff background = custom.
      if (d.background === 'custom' && !d.customBackground) {
        markFallback();
        return { ...d, background: 'default', customBackground: null };
      }
      if (d.background !== 'custom' && d.customBackground) {
        markFallback();
        return { ...d, customBackground: null };
      }
      return d;
    });
}

/**
 * Visibility via CSS media classes only (no JS): phone < 768px, tablet 768–1023px, desktop ≥ 1024px
 * (the header switches to its desktop layout at the same `lg` breakpoint).
 */
export function visibilityClasses(v: SectionDesign['visibility']): string {
  return [!v.phone && 'max-md:hidden', !v.tablet && 'md:max-lg:hidden', !v.desktop && 'lg:hidden'].filter(Boolean).join(' ');
}

const BG_VAR: Record<Exclude<SectionDesign['background'], 'custom'>, string> = {
  default: 'transparent',
  muted: 'var(--color-sunken)',
  brand: 'var(--color-brand)',
  accent: 'var(--color-accent)',
  inverse: 'var(--color-inverse)',
};

const LIGHT = '#fffcf8';
const DARK = '#0e1a33';

/** Resolve "auto" text tone: light on brand/inverse, readable ink on accent/custom, inherit otherwise. */
export function resolveTextTone(d: SectionDesign): 'light' | 'dark' | null {
  if (d.textTone !== 'auto') return d.textTone;
  if (d.background === 'brand' || d.background === 'inverse') return 'light';
  if (d.background === 'custom' && d.customBackground) return readableInk(d.customBackground, LIGHT, DARK) === LIGHT ? 'light' : 'dark';
  return null;
}

/** Wrapper class + style for a section (`--sp-section-bg`, `--sp-pt`, `--sp-pb`). */
export function sectionFrame(d: SectionDesign): { className: string; style: CSSProperties } {
  const custom = d.background === 'custom' ? sanitizeHex(d.customBackground) : null;
  const bg = custom ?? BG_VAR[d.background === 'custom' ? 'default' : d.background];
  const tone = resolveTextTone(d);
  const style = {
    '--sp-section-bg': bg,
    '--sp-pt': `${Math.min(160, Math.max(0, Math.round(d.paddingTop / 8) * 8))}px`,
    '--sp-pb': `${Math.min(160, Math.max(0, Math.round(d.paddingBottom / 8) * 8))}px`,
  } as CSSProperties;
  const className = ['sp-section', tone === 'light' && 'tone-light', tone === 'dark' && 'tone-dark', visibilityClasses(d.visibility)]
    .filter(Boolean)
    .join(' ');
  return { className, style };
}
