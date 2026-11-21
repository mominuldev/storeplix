import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import defaults from '@storeplix/themes/modern-commerce/defaults.json';
import { modernCommerce } from '@/themes/modern-commerce';
import { resolveThemeConfig } from '@/themes/resolve';
import { SectionFrame } from '@/themes/section-frame';
import { Header } from '@/themes/modern-commerce/header';
import { Footer } from '@/themes/modern-commerce/footer';
import type { ModernCommerceSettings } from '@/themes/modern-commerce/schema';
import type { SectionContext } from '@/themes/types';

const ULID = '01jcz8m4q9w7t3x5y6z8a0b2c4';
const store = {
  id: '1', name: 'Demo Store', slug: 'demo', status: 'active' as const, currency: 'BDT', logo_url: null, favicon_url: null,
  icons: { apple_touch: null, icon_192: null, icon_512: null }, primary_host: 'demo.localhost',
};
const ctx = (media: SectionContext['media'] = {}): SectionContext => ({ store, host: 'demo.localhost', media });

async function renderHome(raw: unknown, media: SectionContext['media'] = {}) {
  const config = resolveThemeConfig(modernCommerce, raw);
  const parts = await Promise.all(
    config.sections
      .filter((s) => s.enabled)
      .map(async (s) => {
        const { Component } = modernCommerce.sections[s.type]!;
        // Sections may be async server components: resolve them before static rendering.
        const el = (await (Component as unknown as (p: object) => Promise<ReactElement> | ReactElement)({ id: s.id, settings: s.settings, blocks: s.blocks, ctx: ctx(media) })) as ReactElement;
        return renderToStaticMarkup(createElement(SectionFrame, { id: s.id, type: s.type, design: s.settings.design, children: el }));
      }),
  );
  return parts.join('\n');
}

describe('home sections (Figma 1:10112 / 1:10335)', () => {
  it('renders all 10 default sections, each wrapped with its id, in order', async () => {
    const withText = { ...structuredClone(defaults), sections: [...structuredClone(defaults).sections, { id: 'r1chtxt1', type: 'rich-text', enabled: true, settings: { heading: 'About', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello <b>' }] }] } } }] };
    const html = await renderHome(withText);
    const ids = [...html.matchAll(/data-sp-section-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...defaults.sections.map((s) => s.id), 'r1chtxt1']);
    for (const text of ['Little things,', 'Shop by age', "Today&#x27;s flash deals", 'Six rooms, one visit', 'Fresh from the gallery', 'Warm layers for Dhaka winters.', 'Play, nourish, every day', 'What parents keep coming back for', 'Cash on delivery', '11,000 reviews, 4.9 average', 'Hello &lt;b&gt;']) {
      expect(html).toContain(text);
    }
  });

  it('applies design: phone-hidden bestsellers, muted background, padding variables', async () => {
    const html = await renderHome(defaults);
    expect(html).toMatch(/data-sp-section-id="b3st0001"[^>]*class="sp-section max-md:hidden"[^>]*style="--sp-section-bg:var\(--color-sunken\);--sp-pt:96px;--sp-pb:112px"/);
  });

  it('skips disabled sections', async () => {
    const cfg = structuredClone(defaults);
    cfg.sections.forEach((s) => (s.enabled = s.type === 'hero'));
    const html = await renderHome(cfg);
    expect([...html.matchAll(/data-sp-section-id=/g)]).toHaveLength(1);
  });

  it('resolves media ids through the media map and falls back to bundled demo images', async () => {
    const cfg = structuredClone(defaults);
    (cfg.sections[0]!.settings as Record<string, unknown>).imageMediaId = ULID;
    const hero = { ...cfg, sections: [cfg.sections[0]!] };
    const withMedia = await renderHome(hero, { [ULID]: { id: ULID, url: 'https://cdn.storeplix.com/hero.webp', width: 900, height: 1000, alt: null, srcset: [] } });
    expect(withMedia).toContain('https://cdn.storeplix.com/hero.webp');
    expect(withMedia).not.toContain('hero-main.png');
    const missing = await renderHome(hero, {});
    expect(missing).toContain('hero-main.png');
  });

  it('shows the flash-sale countdown only for a future endsAt', async () => {
    const cfg = structuredClone(defaults);
    const flash = cfg.sections.find((s) => s.type === 'flash-sale')!;
    const one = { ...cfg, sections: [flash] };
    expect(await renderHome(one)).not.toContain('role="timer"');
    (flash.settings as Record<string, unknown>).endsAt = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    expect(await renderHome(one)).toContain('role="timer"');
    (flash.settings as Record<string, unknown>).endsAt = '2020-01-01T00:00:00Z';
    expect(await renderHome(one)).not.toContain('role="timer"');
  });
});

describe('chrome: header, drawer and footer', () => {
  const settings = resolveThemeConfig(modernCommerce, defaults).settings as ModernCommerceSettings;
  const contact = { phone: '+8801700000000', email: null, whatsapp: '+8801700000000', support_hours: null };
  const menu = {
    title: 'Main menu',
    items: [
      { id: 'm1', label: 'Winter wear', href: '/collections/winter', children: [{ id: 'm2', label: 'Jackets', href: '/collections/jackets', children: [] }] },
      { id: 'm3', label: 'Partner', href: 'https://partner.example.com/', children: [] },
    ],
  };

  it('renders the main menu with a dropdown, external rel, promo link and the mobile drawer', () => {
    const html = renderToStaticMarkup(createElement(Header, { store, settings, contact, menu }));
    expect(html).toContain('href="/collections/winter"');
    expect(html).toContain('href="/collections/jackets"');
    expect(html).toContain('href="https://partner.example.com/" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('Winter offers');
    expect(html).toContain('Free delivery inside Dhaka');
    expect(html).toContain('aria-label="Menu"');
    expect(html).toContain('<dialog');
    expect(html).toContain('sticky top-0');
  });

  it('hides the announcement bar and search when switched off', () => {
    const s = { ...settings, announcement: { ...settings.announcement, enabled: false }, header: { ...settings.header, showSearch: false, sticky: false } };
    const html = renderToStaticMarkup(createElement(Header, { store, settings: s, contact, menu: { title: 'Main', items: [] } }));
    expect(html).not.toContain('Free delivery inside Dhaka');
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain('sticky top-0');
  });

  it('footer: footer/help menus as columns (menu titles) and payment badges', () => {
    const html = renderToStaticMarkup(
      createElement(Footer, {
        store, settings, description: null, contact, social: { facebook: null, instagram: null, youtube: null },
        menus: [
          { title: 'Shop', items: [{ id: 'f1', label: 'Home', href: '/', children: [] }] },
          { title: 'Help', items: [{ id: 'h1', label: 'Contact', href: '/pages/contact', children: [] }] },
        ],
      }),
    );
    expect(html).toContain('>Shop</h2>');
    expect(html).toContain('>Help</h2>');
    expect(html).toContain('href="/pages/contact"');
    for (const p of ['Cash on delivery', 'bKash', 'Nagad', 'Visa', 'Mastercard']) expect(html).toContain(p);
    const off = renderToStaticMarkup(
      createElement(Footer, { store, settings: { ...settings, footer: { ...settings.footer, showPaymentMethods: false } }, description: null, contact, social: { facebook: null, instagram: null, youtube: null }, menus: [] }),
    );
    expect(off).not.toContain('Pay with');
  });
});
