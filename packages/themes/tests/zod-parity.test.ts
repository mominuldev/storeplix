import { describe, expect, it } from 'vitest';
import { resolveThemeConfig } from '../../../apps/storefront/themes/resolve';
import { modernCommerce } from '../../../apps/storefront/themes/modern-commerce';
import { compileSchema, fixtures } from './helpers';

/**
 * Parity between the JSON Schema (source of truth; Laravel validates with it on save) and the
 * storefront's self-healing Zod resolver (render time):
 *  - every valid fixture: AJV accepts AND the resolver uses no fallback (nothing healed or dropped)
 *  - every invalid fixture: AJV rejects AND the resolver never throws (renders with defaults)
 */
const validate = compileSchema();

describe('storefront Zod resolver vs schema.v1.json', () => {
  it.each(fixtures('valid').map((f) => [f.name, f.data] as const))('valid %s → AJV ok, usedFallback false', (_n, data) => {
    expect(validate(data)).toBe(true);
    const resolved = resolveThemeConfig(modernCommerce, data);
    expect(resolved.usedFallback).toBe(false);
    expect(resolved.sections).toHaveLength((data as { sections: unknown[] }).sections.length);
  });

  const invalid = fixtures('invalid') as Array<{ name: string; data: { config: unknown } }>;
  it.each(invalid.map((f) => [f.name, f.data.config] as const))('invalid %s → AJV rejects, resolver never throws', (_n, config) => {
    expect(validate(config)).toBe(false);
    expect(() => resolveThemeConfig(modernCommerce, config)).not.toThrow();
  });

  it('the resolver flags (usedFallback) every invalid value; only unknown/missing keys are healed silently', () => {
    // By design the resolver strips unknown keys and fills missing ones from defaults without
    // flagging, so Phase 2 (1.0) configs render cleanly. Everything else must be noticed.
    const SILENT = [
      '05-unknown-settings-key.json',
      '06-missing-settings-key.json',
      '18-section-unknown-key.json',
      '21-hero-heading-missing.json',
      '26-hero-missing-blocks.json',
      '28-hero-image-url-field.json',
      '41-block-settings-unknown-key.json',
      '45-rich-text-link-extra-attrs.json',
    ];
    const missed = invalid.filter((f) => !resolveThemeConfig(modernCommerce, f.data.config).usedFallback).map((f) => f.name);
    expect(missed).toEqual(SILENT);
  });
});
