import { z } from 'zod';
import { sanitizeColor, sanitizeHref, sanitizeImageUrl } from '@/lib/sanitize';
import { FONT_NAMES, type FontFamilyName } from './fonts';

/** Color field: only hex / rgb() / rgba(); anything else falls back to `def`. */
// z.preprocess (not z.unknown().transform) so the sanitizer also runs for *missing* keys.
export const colorField = (def: string) => z.preprocess((v) => sanitizeColor(v) ?? def, z.string());

/** Plain text field: trimmed, length-capped; non-strings fall back. Rendered as text, never HTML. */
export const textField = (def: string, max = 200) =>
  z.string().trim().min(1).max(max).catch(def);

export const optionalTextField = (max = 200) =>
  z.string().trim().max(max).optional().catch(undefined);

export const hrefField = (def: string) => z.preprocess((v) => sanitizeHref(v) ?? def, z.string());

export const optionalHrefField = () => z.preprocess((v) => sanitizeHref(v) ?? undefined, z.string().optional());

export const imageField = (def: string) => z.preprocess((v) => sanitizeImageUrl(v) ?? def, z.string());

export const fontField = (def: FontFamilyName) => z.enum(FONT_NAMES).catch(def);

export const intField = (def: number, min: number, max: number) =>
  z.number().int().min(min).max(max).catch(def);

export const boolField = (def: boolean) => z.boolean().catch(def);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Object of self-healing fields: a non-object input is treated as `{}` so every field defaults. */
export const settingsObject = <S extends z.ZodRawShape>(shape: S) =>
  z.preprocess((v) => (isPlainObject(v) ? v : {}), z.object(shape));
