import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CurrentStore, StoreMode } from '@/lib/store';
import { resolveStoreTheme } from '@/themes/registry';
import { robotsResponse, sitemapResponse } from '@/lib/seo-files';

let current: CurrentStore;
vi.mock('@/lib/store', () => ({
  requireCurrentStore: async () => current,
  findCurrentStore: async () => current,
}));

const { default: StoreLayout, generateMetadata } = await import('@/app/(store)/layout');

function makeStore(status: 'active' | 'draft', mode: StoreMode): CurrentStore {
  const { theme, config: themeConfig } = resolveStoreTheme(undefined);
  return {
    host: 'demo.localhost',
    mode,
    theme,
    themeConfig,
    config: {
      store: {
        id: '01J', name: 'Demo Store', slug: 'demo', status, currency: 'BDT', logo_url: null, favicon_url: null,
        icons: { apple_touch: null, icon_192: null, icon_512: null },
      },
      contact: { phone: null, email: null, whatsapp: null, support_hours: null },
      social: { facebook: null, instagram: null, youtube: null },
      preview: mode === 'preview',
      theme: undefined,
      seo: { title: 'Demo Store', description: 'Desc' },
    },
  };
}

async function render(children = 'STORE CONTENT') {
  return renderToStaticMarkup(await StoreLayout({ children }));
}

describe('draft store (public visitor)', () => {
  beforeEach(() => {
    current = makeStore('draft', 'coming_soon');
  });

  it('renders a branded Coming soon page instead of the store, on any path', async () => {
    const html = await render();
    expect(html).toContain('Coming soon');
    expect(html).toContain('Demo Store');
    expect(html).not.toContain('STORE CONTENT');
    expect(html).not.toContain('Preview');
  });

  it('is noindex with no canonical/OG', async () => {
    const meta = await generateMetadata();
    expect(meta.robots).toMatchObject({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
    expect(meta.openGraph).toBeUndefined();
  });

  it('robots.txt disallows everything and the sitemap is empty, both uncacheable', async () => {
    const robots = robotsResponse(current);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(robots.headers.get('cache-control')).toBe('private, no-store');

    const sitemap = sitemapResponse(current);
    const xml = await sitemap.text();
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<url>');
    expect(sitemap.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('preview', () => {
  it('renders the real store with a "Preview — not public yet" banner for a draft store', async () => {
    current = makeStore('draft', 'preview');
    const html = await render();
    expect(html).toContain('Preview — not public yet');
    expect(html).toContain('STORE CONTENT');
    expect(html).not.toContain('Coming soon');
    expect((await generateMetadata()).robots).toMatchObject({ index: false });
    expect(await robotsResponse(current).text()).toContain('Disallow: /');
  });

  it('labels previews of an already-active store as preview mode', async () => {
    current = makeStore('active', 'preview');
    expect(await render()).toContain('Preview mode');
  });
});

describe('icons metadata', () => {
  it('uses the store favicon/apple/manifest icons, else the platform favicon', async () => {
    current = makeStore('active', 'live');
    expect((await generateMetadata()).icons).toEqual({ icon: [{ url: '/platform/storeplix-favicon.svg', type: 'image/svg+xml' }] });
    expect((await generateMetadata()).manifest).toBeUndefined();

    current.config.store.favicon_url = 'https://cdn.storeplix.com/f.png';
    current.config.store.icons = { apple_touch: 'https://cdn.storeplix.com/a.png', icon_192: 'https://cdn.storeplix.com/i.png', icon_512: null };
    const meta = await generateMetadata();
    expect(meta.icons).toMatchObject({ icon: [{ url: 'https://cdn.storeplix.com/f.png', sizes: '32x32' }], apple: [{ sizes: '180x180' }] });
    expect(meta.manifest).toBe('/manifest.webmanifest');
  });
});

describe('live store', () => {
  it('renders the store without banner, indexable, with a sitemap', async () => {
    current = makeStore('active', 'live');
    const html = await render();
    expect(html).toContain('STORE CONTENT');
    expect(html).not.toContain('Preview');
    expect((await generateMetadata()).robots).toBeUndefined();
    expect(await robotsResponse(current).text()).toContain('Allow: /');
    expect(await sitemapResponse(current).text()).toContain('<loc>http://demo.localhost:3000/</loc>');
  });
});
