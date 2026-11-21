import { z } from 'zod';
import { sanitizeHex, sanitizeHref, sanitizeMediaId } from '@/lib/sanitize';
import { cleanText } from '@/lib/text';
import { FONT_NAMES, type FontFamilyName } from './fonts';

export { cleanText };

/**
 * Self-healing Zod field builders for theme config. Every field parses untrusted merchant JSON and
 * never throws: a missing key gets its default silently; a present-but-invalid value gets its default
 * AND is recorded as a fallback, so `ResolvedThemeConfig.usedFallback` is exact (the fixture parity
 * test requires `false` for every schema-valid config).
 *
 * The recorder is module state, which is safe because resolving is fully synchronous.
 */
let recorder: { hit: boolean } | null = null;

export function markFallback(): void {
  if (recorder) recorder.hit = true;
}

/** Run `fn` and report whether any field fell back to its default because of an invalid value. */
export function recordFallbacks<T>(fn: () => T): { value: T; fallback: boolean } {
  const previous = recorder;
  const current = { hit: false };
  recorder = current;
  try {
    return { value: fn(), fallback: current.hit };
  } finally {
    recorder = previous;
    if (previous && current.hit) previous.hit = true;
  }
}

/**
 * Generic field: `parse` returns the clean value or `undefined` for "invalid". `z.preprocess` (not
 * `z.unknown().transform`) so the field also runs for *missing* keys and always yields a value.
 */
export function field<T>(parse: (v: unknown) => T | undefined, def: T) {
  return z.preprocess((v) => {
    if (v === undefined) return def;
    const out = parse(v);
    if (out === undefined) {
      markFallback();
      return def;
    }
    return out;
  }, z.any() as z.ZodType<T>);
}

export const textField = (def: string, max: number) => field((v) => cleanText(v, max), def);
/** Required text (schema minLength 1): an empty value falls back. */
export const reqTextField = (def: string, max: number) => field((v) => cleanText(v, max, 1), def);
export const nullableTextField = (def: string | null, max: number) =>
  field<string | null>((v) => (v === null ? null : cleanText(v, max)), def);

export const hexField = (def: string) => field((v) => sanitizeHex(v) ?? undefined, def);
export const hrefField = (def: string) => field((v) => sanitizeHref(v) ?? undefined, def);
export const optionalHrefField = (def: string | null = null) => field<string | null>((v) => sanitizeHref(v) ?? undefined, def);
export const nullableHrefField = () =>
  field<string | null>((v) => (v === null ? null : (sanitizeHref(v) ?? undefined)), null);
export const mediaIdField = () =>
  field<string | null>((v) => (v === null ? null : (sanitizeMediaId(v) ?? undefined)), null);
export const fontField = (def: FontFamilyName) =>
  field((v) => (typeof v === 'string' && (FONT_NAMES as readonly string[]).includes(v) ? (v as FontFamilyName) : undefined), def);
export const boolField = (def: boolean) => field((v) => (typeof v === 'boolean' ? v : undefined), def);
export const intField = (def: number, min: number, max: number, step = 1) =>
  field((v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max && v % step === 0 ? v : undefined), def);
export const enumField = <const T extends readonly [string, ...string[]]>(values: T, def: T[number]) =>
  field((v) => (typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T[number]) : undefined), def);

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Object of self-healing fields. Missing → `{}` (every field defaults, no fallback); a non-object
 * value → `{}` and recorded as a fallback. Unknown keys are stripped (older configs carry extras).
 */
export const settingsObject = <S extends z.ZodRawShape>(shape: S) =>
  z.preprocess((v) => {
    if (isPlainObject(v)) return v;
    if (v !== undefined) markFallback();
    return {};
  }, z.object(shape));
