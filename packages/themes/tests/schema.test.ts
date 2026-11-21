import { describe, expect, it } from 'vitest';
import { compileSchema, errorPaths, fixtures, readJson } from './helpers';

const validate = compileSchema();
const defaults = readJson('modern-commerce/defaults.json') as { sections: Array<{ type: string; id: string }> };
const manifest = readJson('modern-commerce/manifest.json') as {
  version: string;
  sections: Array<{ type: string; maxInstances: number; blocks?: { max: number }; preset: Record<string, unknown> }>;
  stylePresets: Array<{ id: string; pairing: string }>;
};
const registry = readJson('registry.json') as Array<Record<string, unknown>>;
const fonts = readJson('fonts.json') as { fonts: Array<{ family: string }>; pairings: Array<{ id: string; fontFamily: string; headingFontFamily: string }> };
const schema = readJson('modern-commerce/schema.v1.json') as {
  $defs: { font: { enum: string[] }; globalSettings: { properties: { stylePreset: { enum: Array<string | null> } } }; section: { properties: { type: { enum: string[] } } } };
};

describe('schema.v1.json: valid fixtures', () => {
  const valid = fixtures('valid');
  it('has at least 6 valid fixtures', () => expect(valid.length).toBeGreaterThanOrEqual(6));

  it.each(valid.map((f) => [f.name, f.data] as const))('%s validates', (_name, data) => {
    const ok = validate(data);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each(valid.map((f) => [f.name, f.data] as const))('%s respects maxInstances (API semantic check)', (_name, data) => {
    const sections = (data as { sections: Array<{ type: string }> }).sections;
    for (const s of manifest.sections) {
      expect(sections.filter((x) => x.type === s.type).length, s.type).toBeLessThanOrEqual(s.maxInstances);
    }
  });

  it('defaults.json validates and equals valid/01-defaults.json', () => {
    expect(validate(defaults)).toBe(true);
    expect(valid.find((f) => f.name === '01-defaults.json')!.data).toEqual(defaults);
  });
});

describe('schema.v1.json: invalid fixtures', () => {
  const invalid = fixtures('invalid') as Array<{ name: string; data: { expect: string; config: unknown } }>;
  it('has at least 20 invalid fixtures, each with an expect path', () => {
    expect(invalid.length).toBeGreaterThanOrEqual(20);
    for (const f of invalid) expect(typeof f.data.expect, f.name).toBe('string');
  });

  it.each(invalid.map((f) => [f.name, f.data] as const))('%s is rejected at its expect path', (_name, { expect: path, config }) => {
    expect(validate(config)).toBe(false);
    expect(errorPaths(validate.errors)).toContain(path);
  });
});

describe('manifest / registry / fonts consistency', () => {
  it('manifest covers exactly the schema section types and its add-section presets validate', () => {
    const types = schema.$defs.section.properties.type.enum;
    expect(manifest.sections.map((s) => s.type).sort()).toEqual([...types].sort());
    manifest.sections.forEach((s, i) => {
      // The editor generates ids for the preset's section and blocks.
      const preset = structuredClone(s.preset) as { blocks?: Array<Record<string, unknown>> };
      preset.blocks?.forEach((b, j) => (b.id = `blk${i}x${String(j).padStart(4, '0')}`));
      const config = { ...(defaults as object), sections: [{ id: `preset${String(i).padStart(3, '0')}`, enabled: true, ...preset }] };
      const ok = validate(config);
      expect(validate.errors ?? [], s.type).toEqual([]);
      expect(ok).toBe(true);
    });
  });

  it('defaults respect maxInstances and maxBlocks; ids are unique', () => {
    const ids = new Set<string>();
    for (const s of manifest.sections) {
      const ofType = defaults.sections.filter((d) => d.type === s.type);
      expect(ofType.length, s.type).toBeLessThanOrEqual(s.maxInstances);
    }
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.type === 'string') {
          expect(ids.has(o.id), o.id).toBe(false);
          ids.add(o.id);
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(defaults.sections);
  });

  it('style presets match the schema enum and use known pairings', () => {
    const enumIds = schema.$defs.globalSettings.properties.stylePreset.enum.filter((x) => x !== null);
    expect(manifest.stylePresets.map((p) => p.id)).toEqual(enumIds);
    const pairings = new Set(fonts.pairings.map((p) => p.id));
    for (const p of manifest.stylePresets) expect(pairings.has(p.pairing), p.id).toBe(true);
  });

  it('fonts.json matches the schema font enum and pairings only use allowlisted fonts', () => {
    expect(fonts.fonts.map((f) => f.family)).toEqual(schema.$defs.font.enum);
    const allowed = new Set(schema.$defs.font.enum);
    for (const p of fonts.pairings) {
      expect(allowed.has(p.fontFamily)).toBe(true);
      expect(allowed.has(p.headingFontFamily)).toBe(true);
    }
  });

  it('registry lists 9 themes; only modern-commerce is available and its version matches the manifest', () => {
    expect(registry).toHaveLength(9);
    const available = registry.filter((t) => t.status === 'available');
    expect(available.map((t) => t.code)).toEqual(['modern-commerce']);
    expect(available[0]!.version).toBe(manifest.version);
    for (const t of registry) {
      expect(Object.keys(t).sort()).toEqual(['code', 'currency', 'description', 'is_new', 'name', 'price_amount', 'status', 'tags', 'tier', 'version']);
      expect(t.tier === 'premium').toBe(t.price_amount !== null);
    }
  });
});
