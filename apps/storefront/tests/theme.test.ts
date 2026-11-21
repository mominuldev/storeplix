import { describe, expect, it } from 'vitest';
import { getTheme, resolveStoreTheme, themeRegistry } from '@/themes/registry';
import { isCompatibleVersion, resolveThemeConfig } from '@/themes/resolve';
import { themeCssVars } from '@/themes/css-vars';
import { modernCommerce } from '@/themes/modern-commerce';
import type { HeroSettings, ModernCommerceSettings } from '@/themes/modern-commerce/schema';

const valid = {
  theme: 'modern-commerce',
  version: '1.0.0',
  settings: { primaryColor: '#123456', secondaryColor: 'rgb(255, 122, 0)', fontFamily: 'Inter' },
  sections: [
    { type: 'hero', enabled: true, settings: { heading: 'Hello', primaryCtaHref: '/sale' } },
    { type: 'featured-products', enabled: false, settings: { limit: 2 } },
  ],
};

describe('theme registry', () => {
  it('registers modern-commerce v1.0.0 with hero and featured-products sections', () => {
    const t = getTheme('modern-commerce');
    expect(t?.version).toBe('1.0.0');
    expect(Object.keys(t!.sections).sort()).toEqual(['featured-products', 'hero']);
    expect(Object.keys(t!.sectionSchemas).sort()).toEqual(['featured-products', 'hero']);
  });

  it('does not resolve prototype keys as themes', () => {
    expect(getTheme('__proto__')).toBeUndefined();
    expect(getTheme('constructor')).toBeUndefined();
    expect(getTheme(42)).toBeUndefined();
  });

  it('falls back to the default theme for unknown theme ids', () => {
    const { theme, config } = resolveStoreTheme({ ...valid, theme: 'does-not-exist' });
    expect(theme.id).toBe('modern-commerce');
    expect(config.usedFallback).toBe(true);
    expect(config.settings.primaryColor).toBe('#0846c2');
  });

  it('every registered theme renders from an empty config', () => {
    for (const t of Object.values(themeRegistry)) {
      const c = resolveThemeConfig(t, undefined);
      expect(c.sections.length).toBeGreaterThan(0);
      expect(c.usedFallback).toBe(false);
    }
  });
});

describe('resolveThemeConfig', () => {
  it('accepts a valid config', () => {
    const c = resolveThemeConfig(modernCommerce, valid);
    expect(c.usedFallback).toBe(false);
    expect(c.settings).toMatchObject({ primaryColor: '#123456', secondaryColor: 'rgb(255, 122, 0)', fontFamily: 'Inter' });
    expect(c.sections.map((s) => [s.type, s.enabled])).toEqual([
      ['hero', true],
      ['featured-products', false],
    ]);
    const hero = c.sections[0]!.settings as HeroSettings;
    expect(hero.heading).toBe('Hello');
    expect(hero.primaryCtaHref).toBe('/sale');
    expect(hero.primaryCtaLabel).toBe('Shop new arrivals'); // missing field -> default
    expect(c.sections[1]!.settings).toMatchObject({ limit: 2 });
  });

  it.each([null, undefined, 'garbage', 42, [], { theme: 'modern-commerce' }])('falls back to defaults for %j', (raw) => {
    const c = resolveThemeConfig(modernCommerce, raw);
    expect(c.settings.primaryColor).toBe('#0846c2');
    expect(c.settings.fontFamily).toBe('Instrument Sans');
    expect(c.sections.map((s) => s.type)).toEqual(['hero', 'featured-products']);
  });

  it('uses defaults when the config was written for another major version', () => {
    const c = resolveThemeConfig(modernCommerce, { ...valid, version: '2.0.0' });
    expect(c.usedFallback).toBe(true);
    expect(c.settings.primaryColor).toBe('#0846c2');
  });

  it('replaces unsafe or invalid setting values field-by-field', () => {
    const c = resolveThemeConfig(modernCommerce, {
      ...valid,
      settings: {
        primaryColor: 'red; background:url(https://evil.example)',
        secondaryColor: '#00ff00',
        fontFamily: 'Comic Sans"; } * { display:none',
        announcement: 12345,
        navigation: [{ label: 'Ok', href: '/ok' }, { label: 'XSS', href: 'javascript:alert(1)' }, 'junk'],
        social: { facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/demo' },
      },
    });
    const s = c.settings as ModernCommerceSettings;
    expect(s.primaryColor).toBe('#0846c2');
    expect(s.secondaryColor).toBe('#00ff00');
    expect(s.fontFamily).toBe('Instrument Sans');
    expect(s.announcement).toBe('Cash on delivery nationwide');
    expect(s.navigation).toEqual([
      { label: 'Ok', href: '/ok' },
      { label: 'XSS', href: '/' },
    ]);
    expect(s.social.facebook).toBeUndefined();
    expect(s.social.instagram).toBe('https://instagram.com/demo');
  });

  it('drops unknown and malformed sections, keeps valid ones', () => {
    const c = resolveThemeConfig(modernCommerce, {
      ...valid,
      sections: [
        { type: 'script', enabled: true, settings: { html: '<script>alert(1)</script>' } },
        { type: 'hero', enabled: 'yes' },
        'nope',
        { enabled: true },
        { type: 'featured-products', enabled: true, settings: { limit: 999 } },
      ],
    });
    expect(c.usedFallback).toBe(true);
    expect(c.sections.map((s) => [s.type, s.enabled])).toEqual([
      ['hero', true],
      ['featured-products', true],
    ]);
    expect(c.sections[1]!.settings).toMatchObject({ limit: 4 });
  });

  it('sanitizes hero links and images', () => {
    const c = resolveThemeConfig(modernCommerce, {
      ...valid,
      sections: [
        {
          type: 'hero',
          enabled: true,
          settings: { primaryCtaHref: 'javascript:alert(1)', image: 'http://insecure/x.png', secondaryCtaHref: '//evil' },
        },
      ],
    });
    const hero = c.sections[0]!.settings as HeroSettings;
    expect(hero.primaryCtaHref).toBe('/collections/new');
    expect(hero.image).toBe('/themes/modern-commerce/images/hero-main.png');
    expect(hero.secondaryCtaHref).toBeUndefined();
  });

  it('caps the number of sections', () => {
    const many = Array.from({ length: 100 }, () => ({ type: 'hero', enabled: true }));
    expect(resolveThemeConfig(modernCommerce, { ...valid, sections: many }).sections).toHaveLength(30);
  });
});

describe('isCompatibleVersion', () => {
  it.each([
    ['1.0.0', '1.0.0', true],
    ['1.4.2', '1.0.0', true],
    ['2.0.0', '1.0.0', false],
    ['1', '1.0.0', false],
    ['', '1.0.0', false],
  ])('%s vs %s -> %s', (a, b, ok) => {
    expect(isCompatibleVersion(a, b)).toBe(ok);
  });
});

describe('themeCssVars', () => {
  const defaults = resolveThemeConfig(modernCommerce, undefined).settings;

  it('maps merchant colors and fonts to CSS variables', () => {
    const vars = themeCssVars({ ...defaults, primaryColor: '#123456', fontFamily: 'Inter' }, defaults) as Record<string, string>;
    expect(vars['--sp-brand']).toBe('#123456');
    expect(vars['--sp-on-brand']).toBe('#fffcf8');
    expect(vars['--sp-font-body']).toContain('var(--font-inter)');
  });

  it('never emits unsanitized values even if handed raw input', () => {
    const vars = themeCssVars(
      { ...defaults, primaryColor: 'red;}</style><script>', secondaryColor: 'url(x)', fontFamily: 'evil', headingFontFamily: 'x' },
      defaults,
    ) as Record<string, string>;
    expect(vars['--sp-brand']).toBe('#0846c2');
    expect(vars['--sp-accent']).toBe('#ff7a00');
    expect(vars['--sp-font-body']).toContain('var(--font-instrument-sans)');
    expect(vars['--sp-font-heading']).toContain('var(--font-fraunces)');
  });
});
