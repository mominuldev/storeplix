import type { ThemeConfig } from '@storeplix/types';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import modernCommerceSchema from '@storeplix/themes/modern-commerce/schema.v1.json';
import { getThemeDefinition } from '../theme-package';

/** JSON Schema (draft 2020-12) per theme code; imported only here so it stays in the editor chunk. */
const schemas: Record<string, object> = { 'modern-commerce': modernCommerceSchema };

// Client-side JSON Schema check (contract P3-5) with the same schema Laravel uses. Loaded only by the editor
// route (React.lazy), so ajv stays out of the main bundle.

const cache = new Map<string, ValidateFunction>();
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function compile(code: string): ValidateFunction | null {
  if (cache.has(code)) return cache.get(code)!;
  const schema = schemas[code];
  if (!schema) return null;
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, strictTypes: false });
  ajv.addFormat('date-time', ISO_DATE_TIME);
  const fn = ajv.compile(schema);
  cache.set(code, fn);
  return fn;
}

/** `/sections/0/settings/heading` → `config.sections.0.settings.heading` (the API's dot-path convention). */
export function toDotPath(instancePath: string, error?: ErrorObject): string {
  const parts = instancePath.split('/').filter(Boolean);
  if (error?.keyword === 'required') parts.push(String((error.params as { missingProperty: string }).missingProperty));
  if (error?.keyword === 'additionalProperties') parts.push(String((error.params as { additionalProperty: string }).additionalProperty));
  return ['config', ...parts].join('.');
}

const friendly = (e: ErrorObject): string => {
  switch (e.keyword) {
    case 'maxLength':
      return `Use at most ${(e.params as { limit: number }).limit} characters.`;
    case 'required':
      return 'This is required.';
    case 'pattern':
      return e.instancePath.toLowerCase().includes('href') ? 'Use a link starting with / or https://' : 'This contains characters that aren’t allowed.';
    case 'maxItems':
      return `Too many items (max ${(e.params as { limit: number }).limit}).`;
    default:
      return e.message ? `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}.` : 'This value isn’t valid.';
  }
};

/** Validates a config; returns `{}` when valid, else `{ "config.sections.0.settings.heading": ["…"] }`. */
export function validateThemeConfig(config: ThemeConfig): Record<string, string[]> {
  const fn = compile(config.theme);
  if (!fn) return { 'config.theme': ['This theme isn’t supported.'] };
  const out: Record<string, string[]> = {};
  const size = new TextEncoder().encode(JSON.stringify(config)).length;
  if (size > (getThemeDefinition(config.theme)?.limits.maxConfigBytes ?? 65_536)) out.config = ['Your theme is too large to save. Remove a section or shorten some text.'];
  if (fn(config)) return out;
  for (const e of fn.errors ?? []) {
    // `if/then` and `oneOf` wrappers repeat the real error; keep the leaf ones.
    if (['if', 'oneOf', 'anyOf', 'allOf'].includes(e.keyword)) continue;
    const path = toDotPath(e.instancePath, e);
    (out[path] ??= []).push(friendly(e));
  }
  return out;
}
