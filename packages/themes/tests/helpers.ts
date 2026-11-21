import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';

export const ROOT = join(__dirname, '..');
export const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

export function fixtures(kind: 'valid' | 'invalid'): Array<{ name: string; data: unknown }> {
  const dir = join(ROOT, 'fixtures/modern-commerce', kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

/** Strict AJV for draft 2020-12; same settings the dashboard uses for client-side checks. */
export function compileSchema() {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allowUnionTypes: true, allErrors: true });
  return ajv.compile(readJson('modern-commerce/schema.v1.json') as object);
}

/** JSON pointer "/sections/0/settings" -> dot path "sections.0.settings" (the API's `details` key, minus "config."). */
export const dotPath = (pointer: string) =>
  pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');

export const errorPaths = (errors: ErrorObject[] | null | undefined) => [...new Set((errors ?? []).map((e) => dotPath(e.instancePath)))];
