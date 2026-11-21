import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SECRETS = ['sp_preview', 'X-Storefront-Preview', 'X-Storefront-Key', 'STOREFRONT_API_KEY', 'REVALIDATE_SECRET'];

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

describe('preview cookie never reaches the client', () => {
  it('cookie reader and API client are server-only modules', () => {
    for (const f of ['lib/preview.ts', 'lib/storefront-api.ts', 'lib/store.ts', 'lib/env.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/^import 'server-only';/);
    }
  });

  it('no client component references the preview cookie, header or secrets', () => {
    const clientFiles = walk(ROOT, ['.ts', '.tsx']).filter((f) =>
      /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')),
    );
    for (const f of clientFiles) {
      const src = readFileSync(f, 'utf8');
      for (const s of [...SECRETS, 'preview-token', 'lib/preview', 'lib/store']) {
        expect(src.includes(s), `${relative(ROOT, f)} references ${s}`).toBe(false);
      }
    }
  });

  it('the built client bundle (if present) contains no preview cookie/header names or secrets', () => {
    const staticDir = join(ROOT, '.next/static');
    if (!existsSync(staticDir)) return; // run after `next build` to cover the real bundle
    for (const f of walk(staticDir, ['.js'])) {
      const src = readFileSync(f, 'utf8');
      for (const s of SECRETS) expect(src.includes(s), `${relative(ROOT, f)} contains ${s}`).toBe(false);
    }
  });
});
