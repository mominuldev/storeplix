import { describe, expect, it } from 'vitest';
import defaults from '@storeplix/themes/modern-commerce/defaults.json';
import { getTheme, resolveStoreTheme, themeRegistry } from '@/themes/registry';
import { isCompatibleVersion, resolveThemeConfig } from '@/themes/resolve';
import { themeCssVars } from '@/themes/css-vars';
import { sectionFrame, visibilityClasses, DEFAULT_DESIGN } from '@/themes/design';
import { modernCommerce } from '@/themes/modern-commerce';
import type { HeroSettings, ModernCommerceSettings } from '@/themes/modern-commerce/schema';

const clone = <T,>(v: T): T => structuredClone(v);
const valid = () => clone(defaults) as unknown as { theme: string; version: string; settings: Record<string, unknown>; sections: Array<Record<string, unknown>> };

describe('theme registry', () => {
  it('registers modern-commerce 1.1.0 ("Gallery") with all 10 section types', () => {
    const t = getTheme('modern-commerce');
    expect(t?.version).toBe('1.1.0');
    expect(t?.name).toBe('Gallery');
    expect(Object.keys(t!.sections).sort()).toEqual(
      ['category-grid', 'chip-links', 'feature-tiles', 'featured-products', 'flash-sale', 'hero', 'image-with-text', 'reviews-club', 'rich-text', 'trust-badges'].sort(),
    );
  });

  it('does not resolve prototype keys as themes', () => {
    expect(getTheme('__proto__')).toBeUndefined();
    expect(getTheme('constructor')).toBeUndefined();
    expect(getTheme(42)).toBeUndefined();
  });

  it('falls back to the default theme for unknown theme ids', () => {
    const { theme, config } = resolveStoreTheme({ ...valid(), theme: 'does-not-exist' });
    expect(theme.id).toBe('modern-commerce');
    expect(config.usedFallback).toBe(true);
    expect(config.settings.primaryColor).toBe('#0846c2');
  });

  it('every registered theme renders the default home from an empty config', () => {
    for (const t of Object.values(themeRegistry)) {
      const c = resolveThemeConfig(t, undefined);
      expect(c.sections.length).toBe(10);
      expect(c.usedFallback).toBe(false);
    }
  });
});

describe('resolveThemeConfig', () => {
  it('accepts defaults.json without fallback and keeps ids, blocks and design', () => {
    const c = resolveThemeConfig(modernCommerce, valid());
    expect(c.usedFallback).toBe(false);
    expect(c.sections.map((s) => s.id)).toEqual(defaults.sections.map((s) => s.id));
    const hero = c.sections[0]!;
    expect((hero.settings as unknown as HeroSettings).heading).toBe('Little things,');
    expect(hero.blocks.map((b) => b.id)).toEqual(['st4t0001', 'st4t0002', 'st4t0003']);
    const best = c.sections.find((s) => s.id === 'b3st0001')!;
    expect(best.settings.design).toMatchObject({ background: 'muted', visibility: { desktop: true, tablet: true, phone: false } });
  });

  it('renders a Phase 2 (1.0.0) config: missing ids become type-index, defaults fill settings and blocks', () => {
    const c = resolveThemeConfig(modernCommerce, {
      theme: 'modern-commerce',
      version: '1.0.0',
      settings: { primaryColor: '#5B53FF', secondaryColor: '#0d0d18', fontFamily: 'Inter', announcement: 'Old string announcement' },
      sections: [{ type: 'hero', enabled: true }, { type: 'featured-products', enabled: true }],
    });
    expect(c.sections.map((s) => s.id)).toEqual(['hero-0', 'featured-products-1']);
    expect(c.settings).toMatchObject({ primaryColor: '#5b53ff', fontFamily: 'Inter', headingFontFamily: 'Fraunces' });
    expect((c.settings as ModernCommerceSettings).announcement).toEqual({ enabled: true, text: 'Old string announcement', href: null });
    expect(c.sections[0]!.blocks).toHaveLength(3); // default stats
    expect(c.usedFallback).toBe(false);
  });

  it.each([null, undefined, 'garbage', 42, [], { theme: 'modern-commerce' }])('falls back to defaults for %j', (raw) => {
    const c = resolveThemeConfig(modernCommerce, raw);
    expect(c.settings.primaryColor).toBe('#0846c2');
    expect(c.settings.fontFamily).toBe('Instrument Sans');
    expect(c.sections).toHaveLength(10);
  });

  it('uses defaults when the config was written for another major version', () => {
    const c = resolveThemeConfig(modernCommerce, { ...valid(), version: '2.0.0' });
    expect(c.usedFallback).toBe(true);
    expect(c.settings.primaryColor).toBe('#0846c2');
  });

  it('replaces unsafe or invalid setting values field-by-field (hex only, closed lists)', () => {
    const cfg = valid();
    cfg.settings = {
      ...cfg.settings,
      primaryColor: 'red; background:url(https://evil.example)',
      secondaryColor: 'rgb(255, 0, 0)',
      textColor: '#00FF00',
      fontFamily: 'Comic Sans"; } * { display:none',
      cornerStyle: 'blob',
      header: { sticky: true, showSearch: true, promoLink: { label: 'XSS', href: 'javascript:alert(1)' } },
    };
    const c = resolveThemeConfig(modernCommerce, cfg);
    const s = c.settings as ModernCommerceSettings;
    expect(c.usedFallback).toBe(true);
    expect(s.primaryColor).toBe('#0846c2');
    expect(s.secondaryColor).toBe('#ff7a00');
    expect(s.textColor).toBe('#00ff00');
    expect(s.fontFamily).toBe('Instrument Sans');
    expect(s.cornerStyle).toBe('pill');
    expect(s.header.promoLink).toEqual({ label: 'Winter offers', href: '/collections/winter' });
  });

  it('drops unknown and malformed sections and blocks, keeps valid ones', () => {
    const cfg = valid();
    const hero = clone(cfg.sections[0]!) as { blocks: Array<Record<string, unknown>> };
    hero.blocks.push({ id: 'st4t0099', type: 'chip', settings: {} }, 'junk' as never);
    const chips = clone(cfg.sections[1]!) as { blocks: Array<{ settings: Record<string, unknown> }> };
    chips.blocks[0]!.settings.href = 'javascript:alert(1)';
    cfg.sections = [
      { id: 'scr1pt00', type: 'script', enabled: true, settings: { html: '<script>alert(1)</script>' } },
      hero as never,
      chips as never,
      'nope' as never,
      { enabled: true },
      { id: 'fp000001', type: 'featured-products', enabled: true, settings: { title: 'X', limit: 999 } },
    ];
    const c = resolveThemeConfig(modernCommerce, cfg);
    expect(c.usedFallback).toBe(true);
    expect(c.sections.map((s) => s.type)).toEqual(['hero', 'chip-links', 'featured-products']);
    expect(c.sections[0]!.blocks).toHaveLength(3);
    expect(c.sections[1]!.blocks).toHaveLength(5); // the chip with a javascript: href is dropped
    expect(c.sections[2]!.settings).toMatchObject({ limit: 4 });
  });

  it('de-duplicates section ids and flags invalid ones', () => {
    const cfg = valid();
    cfg.sections = [clone(cfg.sections[2]!), clone(cfg.sections[2]!), { ...clone(cfg.sections[2]!), id: 'BAD ID' }];
    const c = resolveThemeConfig(modernCommerce, cfg);
    expect(new Set(c.sections.map((s) => s.id)).size).toBe(3);
    expect(c.usedFallback).toBe(true);
  });

  it('never trusts media ids that are not ULIDs and never accepts image URLs', () => {
    const cfg = valid();
    (cfg.sections[0]!.settings as Record<string, unknown>).imageMediaId = '../../etc/passwd';
    (cfg.sections[0]!.settings as Record<string, unknown>).image = 'https://evil.example/x.png';
    const hero = resolveThemeConfig(modernCommerce, cfg).sections[0]!.settings as Record<string, unknown>;
    expect(hero.imageMediaId).toBeNull();
    expect(hero).not.toHaveProperty('image');
  });

  it('caps the number of sections at 30', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `rt${String(i).padStart(6, '0')}`, type: 'rich-text', enabled: true, settings: { doc: { type: 'doc', content: [] } } }));
    const c = resolveThemeConfig(modernCommerce, { ...valid(), sections: many });
    expect(c.sections).toHaveLength(30);
    expect(c.usedFallback).toBe(true);
  });

  it('strips unsafe rich text nodes and links in the Text section', () => {
    const c = resolveThemeConfig(modernCommerce, {
      ...valid(),
      sections: [
        {
          id: 'r1chtxt1', type: 'rich-text', enabled: true,
          settings: { doc: { type: 'doc', content: [
            { type: 'html', content: '<script>alert(1)</script>' },
            { type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
          ] } },
        },
      ],
    });
    expect(c.usedFallback).toBe(true);
    expect(c.sections[0]!.settings.doc).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] });
  });
});

describe('isCompatibleVersion', () => {
  it.each([
    ['1.0.0', '1.1.0', true],
    ['1.4.2', '1.1.0', true],
    ['2.0.0', '1.1.0', false],
    ['1', '1.1.0', false],
    ['', '1.1.0', false],
  ])('%s vs %s -> %s', (a, b, ok) => {
    expect(isCompatibleVersion(a, b)).toBe(ok);
  });
});

describe('themeCssVars', () => {
  const defaults = resolveThemeConfig(modernCommerce, undefined).settings;

  it('maps merchant colours, fonts and corners to CSS variables', () => {
    const vars = themeCssVars({ ...defaults, primaryColor: '#123456', fontFamily: 'Inter', cornerStyle: 'square' }, defaults) as Record<string, string>;
    expect(vars['--sp-brand']).toBe('#123456');
    expect(vars['--sp-on-brand']).toBe('#fffcf8');
    expect(vars['--sp-font-body']).toContain('var(--font-inter)');
    expect(vars['--sp-radius-control']).toBe('4px');
    expect(vars['--sp-ink-secondary']).toBe('#33405c'); // default ink keeps the exact Figma tones
  });

  it('never emits unsanitized values even if handed raw input', () => {
    const vars = themeCssVars(
      {
        ...defaults,
        primaryColor: 'red;}</style><script>',
        secondaryColor: 'url(x)',
        textColor: 'rgb(1,2,3)',
        fontFamily: 'evil',
        headingFontFamily: 'x',
        cornerStyle: 'x' as never,
      },
      defaults,
    ) as Record<string, string>;
    expect(vars['--sp-brand']).toBe('#0846c2');
    expect(vars['--sp-accent']).toBe('#ff7a00');
    expect(vars['--sp-ink']).toBe('#0e1a33');
    expect(vars['--sp-font-body']).toContain('var(--font-instrument-sans)');
    expect(vars['--sp-font-heading']).toContain('var(--font-fraunces)');
    expect(vars['--sp-radius-control']).toBe('999px');
  });
});

describe('section design', () => {
  it('maps visibility to CSS media classes', () => {
    expect(visibilityClasses({ desktop: true, tablet: true, phone: true })).toBe('');
    expect(visibilityClasses({ desktop: true, tablet: true, phone: false })).toBe('max-md:hidden');
    expect(visibilityClasses({ desktop: false, tablet: false, phone: true })).toBe('md:max-lg:hidden lg:hidden');
  });

  it('builds frame variables from allowlisted values only', () => {
    const f = sectionFrame({ ...DEFAULT_DESIGN, background: 'brand', paddingTop: 64, paddingBottom: 96 });
    expect(f.style).toEqual({ '--sp-section-bg': 'var(--color-brand)', '--sp-pt': '64px', '--sp-pb': '96px' });
    expect(f.className).toContain('tone-light');
    const custom = sectionFrame({ ...DEFAULT_DESIGN, background: 'custom', customBackground: 'red;}body{x' as never });
    expect((custom.style as Record<string, string>)['--sp-section-bg']).toBe('transparent');
    const light = sectionFrame({ ...DEFAULT_DESIGN, background: 'custom', customBackground: '#ffffff', textTone: 'auto' });
    expect(light.className).toContain('tone-dark');
  });

  it('heals invalid design values (custom without colour, odd padding)', () => {
    const cfg = valid();
    const s = cfg.sections[2]!.settings as { design: Record<string, unknown> };
    s.design = { ...s.design, background: 'custom', customBackground: null, paddingTop: 12 };
    const c = resolveThemeConfig(modernCommerce, cfg);
    expect(c.sections[2]!.settings.design).toMatchObject({ background: 'default', customBackground: null, paddingTop: 0 });
    expect(c.usedFallback).toBe(true);
  });
});
