import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPageIndexRequest, buildPageRequest } from '@/lib/config-request';
import { getStorefrontConfig, getStorefrontPage, getStorefrontPageIndex } from '@/lib/storefront-api';
import { parseMediaMap, parseNavigation, parseStorefrontPage } from '@/lib/storefront-schemas';

const env = { apiUrl: 'http://api', apiKey: 'k' };
const ULID = '01jcz8m4q9w7t3x5y6z8a0b2c4';

describe('page fetch caching (contract §5.2)', () => {
  it('public page: shared cache, tag store:{host}, revalidate 300', () => {
    const { url, init } = buildPageRequest('demo.localhost', 'about', null, env);
    expect(url).toBe('http://api/api/v1/storefront/pages/about');
    expect(init.next).toEqual({ tags: ['store:demo.localhost'], revalidate: 300 });
    expect(init.headers).not.toHaveProperty('X-Storefront-Preview');
  });

  it('preview page: no-store, never tagged, forwards the token', () => {
    const { init } = buildPageRequest('demo.localhost', 'about', 'tok', env);
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
    expect(init.headers).toMatchObject({ 'X-Storefront-Preview': 'tok' });
  });

  it('page index (sitemap) is always public and tagged', () => {
    expect(buildPageIndexRequest('demo.localhost', env).init.next).toEqual({ tags: ['store:demo.localhost'], revalidate: 300 });
  });
});

describe('storefront API client (Phase 3 payloads)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'k');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const base = {
    store: { id: '01J', name: 'Demo', slug: 'demo', status: 'active', currency: 'BDT', logo_url: null, favicon_url: null },
    preview: false,
    theme: null,
    seo: { title: 'Demo', description: null },
  };

  it('tolerates a Phase 2 payload: no primary_host/navigation/media, short seo', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: base }));
    const res = await getStorefrontConfig('p3-old.localhost', null);
    if (res.status !== 'found') throw new Error('expected found');
    expect(res.config.store.primary_host).toBe('p3-old.localhost');
    expect(res.config.seo).toEqual({ title: 'Demo', description: null, og_image_url: null, noindex: false });
    expect(res.config.navigation.main).toEqual({ title: 'Main menu', items: [] });
    expect(res.config.media).toEqual({});
  });

  it('parses Phase 3 fields and drops unsafe ones', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: {
          ...base,
          store: { ...base.store, primary_host: 'Demo.StorePlix.test' },
          seo: { title: 'T', description: 'D', og_image_url: 'javascript:alert(1)', noindex: true },
          navigation: { main: { title: 'Main', items: [{ id: 'aaaa1111', label: 'About', href: '/pages/about', children: [] }] } },
          media: { [ULID]: { id: ULID, url: 'https://cdn.storeplix.com/x.webp', width: 10, height: 10, alt: null, srcset: [] } },
        },
      }),
    );
    const res = await getStorefrontConfig('p3-new.localhost', null);
    if (res.status !== 'found') throw new Error('expected found');
    expect(res.config.store.primary_host).toBe('demo.storeplix.test');
    expect(res.config.seo).toEqual({ title: 'T', description: 'D', og_image_url: null, noindex: true });
    expect(res.config.navigation.main.items.map((i) => i.label)).toEqual(['About']);
    expect(Object.keys(res.config.media)).toEqual([ULID]);
  });

  it('getStorefrontPage: invalid slugs never hit the API; 404 → null', async () => {
    expect(await getStorefrontPage('a.localhost', '../admin', null)).toBeNull();
    expect(await getStorefrontPage('a.localhost', 'About', null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(Response.json({ error: { code: 'page_not_found' } }, { status: 404 }));
    expect(await getStorefrontPage('a.localhost', 'missing', null)).toBeNull();
  });

  it('getStorefrontPage parses a page', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: {
          id: '01p', slug: 'about', title: 'About us', status: 'published', updated_at: '2026-11-20T10:00:00Z',
          body: [{ id: 'blk00001', type: 'heading', text: 'Hi', level: 2 }], media: {},
          seo: { title: null, description: 'Desc', og_image_url: 'https://cdn.storeplix.com/og.png' },
        },
      }),
    );
    const page = await getStorefrontPage('b.localhost', 'about', null);
    expect(page).toMatchObject({ slug: 'about', title: 'About us', seo: { description: 'Desc', og_image_url: 'https://cdn.storeplix.com/og.png' } });
    expect(page!.body).toHaveLength(1);
  });

  it('getStorefrontPageIndex never throws (endpoint missing → [])', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    expect(await getStorefrontPageIndex('c.localhost')).toEqual([]);
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await getStorefrontPageIndex('c.localhost')).toEqual([]);
    fetchMock.mockResolvedValue(Response.json({ data: [{ slug: 'about', updated_at: '2026-01-01T00:00:00Z' }, { slug: 'BAD SLUG' }] }));
    expect(await getStorefrontPageIndex('c.localhost')).toEqual([{ slug: 'about', updated_at: '2026-01-01T00:00:00Z' }]);
  });
});

describe('payload parsers', () => {
  it('navigation: keeps two levels, drops unsafe hrefs and deeper levels', () => {
    const nav = parseNavigation({
      main: {
        title: 'Main menu',
        items: [
          { id: 'a1', label: 'Shop', href: '/collections/all', children: [{ id: 'a2', label: 'Kids', href: '/collections/kids', children: [{ id: 'a3', label: 'Deep', href: '/x' }] }] },
          { id: 'b1', label: 'Evil', href: 'javascript:alert(1)' },
          { id: 'c1', label: 'Partner', href: 'http://partner.example.com' },
          { id: 'd1', label: '', href: '/' },
        ],
      },
      footer: 'junk',
    });
    expect(nav.main.items.map((i) => i.label)).toEqual(['Shop', 'Partner']);
    expect(nav.main.items[0]!.children[0]!.children).toEqual([]);
    expect(nav.footer).toEqual({ title: 'Shop', items: [] });
  });

  it('media: only ULID keys with safe URLs and dimensions', () => {
    expect(
      Object.keys(
        parseMediaMap({
          [ULID]: { url: 'https://cdn.storeplix.com/a.webp', width: 1, height: 1 },
          '01jcz8m4q9w7t3x5y6z8a0b2c5': { url: 'javascript:alert(1)', width: 1, height: 1 },
          '../x': { url: 'https://cdn.storeplix.com/b.webp', width: 1, height: 1 },
        }),
      ),
    ).toEqual([ULID]);
  });

  it('page: rejects payloads without a valid slug/title', () => {
    expect(parseStorefrontPage({ id: '1', slug: 'Bad Slug', title: 'x' })).toBeNull();
    expect(parseStorefrontPage({ id: '1', slug: 'ok', title: '' })).toBeNull();
    expect(parseStorefrontPage(null)).toBeNull();
  });
});
