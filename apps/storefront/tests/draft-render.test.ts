import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CurrentStore, StoreMode } from '@/lib/store';
import { resolveStoreTheme } from '@/themes/registry';
import { robotsResponse, sitemapResponse } from '@/lib/seo-files';

let current: CurrentStore;
let embedded = false;
vi.mock('@/lib/store', () => ({
  requireCurrentStore: async () => current,
  findCurrentStore: async () => current,
}));
// The real bridge needs the App Router; its logic is covered in preview-bridge.test.ts.
vi.mock('@/components/preview-bridge', async () => {
  const { createElement } = await import('react');
  return { PreviewBridge: ({ allowedOrigins }: { allowedOrigins: string[] }) => createElement('i', { 'data-bridge': allowedOrigins.join(' ') }) };
});
vi.mock('@/lib/preview', () => ({
  isEmbeddedPreview: async () => embedded,
  getPreviewToken: async () => null,
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
        icons: { apple_touch: null, icon_192: null, icon_512: null }, primary_host: 'demo.localhost',
      },
      contact: { phone: null, email: null, whatsapp: null, support_hours: null },
      social: { facebook: null, instagram: null, youtube: null },
      preview: mode === 'preview',
      commerce: null,
      theme: undefined,
      seo: { title: 'Demo Store', description: 'Desc', og_image_url: null, noindex: false },
      navigation: { main: { title: 'Main menu', items: [] }, footer: { title: 'Shop', items: [] }, help: { title: 'Help', items: [] } },
      media: {},
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
  beforeEach(() => {
    embedded = false;
  });

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
    expect(await sitemapResponse(current).text()).toContain('<loc>http://demo.localhost:3010/</loc>');
  });
});

describe('embedded editor preview', () => {
  afterEach(() => {
    embedded = false;
    vi.unstubAllEnvs();
  });

  it('mounts no bridge for a normal preview, and no banner inside the editor iframe', async () => {
    current = makeStore('active', 'preview');
    vi.stubEnv('STOREFRONT_EDITOR_ORIGINS', 'http://localhost:5183, https://*.evil.com');
    expect(await render()).not.toContain('data-bridge');
    embedded = true;
    const html = await render();
    expect(html).toContain('data-bridge="http://localhost:5183"');
    expect(html).not.toContain('Preview mode');
    expect(html).toContain('STORE CONTENT');
  });

  it('never embeds the preview token in the page', async () => {
    current = makeStore('active', 'preview');
    embedded = true;
    expect(await render()).not.toMatch(/sp_preview|X-Storefront-Preview/);
  });
});

describe('SEO (Phase 3)', () => {
  it('canonical, OG url and JSON-LD use the primary host, not the request host', async () => {
    current = makeStore('active', 'live');
    current.host = 'demo.localhost';
    current.config.store.primary_host = 'shop.example.com';
    const meta = await generateMetadata();
    expect(meta.alternates?.canonical).toBe('https://shop.example.com/');
    expect(meta.openGraph).toMatchObject({ url: 'https://shop.example.com/', siteName: 'Demo Store' });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
    const html = await render();
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"url":"https://shop.example.com/"');
  });

  it('uses the store share image, then the logo, for OG', async () => {
    current = makeStore('active', 'live');
    current.config.store.logo_url = 'https://cdn.storeplix.com/logo.png';
    expect((await generateMetadata()).openGraph).toMatchObject({ images: [{ url: 'https://cdn.storeplix.com/logo.png' }] });
    current.config.seo.og_image_url = 'https://cdn.storeplix.com/share.png';
    expect((await generateMetadata()).openGraph).toMatchObject({ images: [{ url: 'https://cdn.storeplix.com/share.png' }] });
  });

  it('escapes the store name inside JSON-LD (no script breakout)', async () => {
    current = makeStore('active', 'live');
    current.config.store.name = '</script><script>alert(1)</script>';
    const html = await render('x');
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!;
    expect(ld).not.toContain('<');
    expect(JSON.parse(ld)[0].name).toBe('</script><script>alert(1)</script>');
  });

  it('"hide from search" → noindex meta, Disallow: / and an empty sitemap; JSON-LD only for live', async () => {
    current = makeStore('active', 'live');
    current.config.seo.noindex = true;
    expect((await generateMetadata()).robots).toMatchObject({ index: false, follow: false });
    expect(await robotsResponse(current).text()).toBe('User-agent: *\nDisallow: /\n');
    expect(await sitemapResponse(current, [{ slug: 'about', updated_at: null }]).text()).not.toContain('<url>');

    current = makeStore('active', 'preview');
    expect(await render()).not.toContain('application/ld+json');
  });

  it('robots.txt (live) disallows /search and points at the primary-host sitemap', async () => {
    current = makeStore('active', 'live');
    current.config.store.primary_host = 'shop.example.com';
    const robots = await robotsResponse(current).text();
    expect(robots).toContain('Disallow: /search');
    expect(robots).toContain('Sitemap: https://shop.example.com/sitemap.xml');
  });

  it('sitemap lists home + published pages with lastmod on the canonical origin', async () => {
    current = makeStore('active', 'live');
    const xml = await sitemapResponse(current, [
      { slug: 'about', updated_at: '2026-11-20T10:00:00Z' },
      { slug: 'contact', updated_at: null },
    ]).text();
    expect(xml).toContain('<url><loc>http://demo.localhost:3010/</loc></url>');
    expect(xml).toContain('<url><loc>http://demo.localhost:3010/pages/about</loc><lastmod>2026-11-20T10:00:00.000Z</lastmod></url>');
    expect(xml).toContain('<loc>http://demo.localhost:3010/pages/contact</loc>');
  });
});
