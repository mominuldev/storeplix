import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Phase 6 (PHASE-6-CONTRACT P6-15, §7, S46): primary-domain redirects. Pure helpers, the proxy's
 * internal path header, the config schema, the 308 from the store lookup and the 301 from
 * robots.txt / sitemap.xml. The API is mocked at fetch.
 */

// ---- framework mocks ----
const req = { headers: new Headers() };
let previewToken: string | null = null;
vi.mock('next/headers', () => ({ headers: async () => req.headers, cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => previewToken, isEmbeddedPreview: async () => false }));
class RedirectError extends Error {
  constructor(public url: string, public status: number) {
    super('NEXT_REDIRECT');
  }
}
vi.mock('next/navigation', () => ({
  permanentRedirect: (url: string) => {
    throw new RedirectError(url, 308);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { STOREFRONT_PATH_HEADER, parseRedirectHost, primaryRedirectTarget, redirectablePath } = await import('@/lib/primary-host');
const { STOREFRONT_HOST_HEADER } = await import('@/lib/host');
const { proxy } = await import('@/proxy');
const { getStorefrontConfig } = await import('@/lib/storefront-api');
const { requireCurrentStore } = await import('@/lib/store');
const robots = await import('@/app/robots.txt/route');
const sitemap = await import('@/app/sitemap.xml/route');

const base = {
  store: { id: '01J', name: 'Acme', slug: 'acme', status: 'active', currency: 'BDT', logo_url: null, favicon_url: null, primary_host: 'shop.acme.com' },
  preview: false,
  theme: null,
  seo: { title: 'Acme', description: null, noindex: false },
};

describe('parseRedirectHost', () => {
  it('accepts bare hostnames, normalised', () => {
    expect(parseRedirectHost('Shop.Acme.com')).toBe('shop.acme.com');
    expect(parseRedirectHost('shop-x.localhost')).toBe('shop-x.localhost');
  });
  it.each([null, undefined, '', 42, 'https://shop.acme.com', 'shop.acme.com/x', 'shop.acme.com:8443', 'a@b.com', 'evil.com\\x', 'a b.com', '127.0.0.1', 'shop.acme.com?x'])(
    'rejects %j',
    (v) => expect(parseRedirectHost(v)).toBeNull(),
  );
});

describe('primaryRedirectTarget', () => {
  afterEach(() => vi.unstubAllEnvs());
  const t = (o: Partial<Parameters<typeof primaryRedirectTarget>[0]>) =>
    primaryRedirectTarget({ redirectHost: 'shop.acme.com', requestHost: 'acme.storeplix.com', preview: false, path: '/products/x?ref=1', ...o });

  it('builds https {origin}{path}{search} for real hosts', () => {
    expect(t({})).toBe('https://shop.acme.com/products/x?ref=1');
    expect(t({ path: '/' })).toBe('https://shop.acme.com/');
  });
  it('uses http + dev port for .localhost and .test hosts', () => {
    vi.stubEnv('STOREFRONT_LOCAL_PORT', '3000');
    expect(t({ redirectHost: 'shop-1.localhost', requestHost: 'acme.storeplix.test' })).toBe('http://shop-1.localhost:3000/products/x?ref=1');
    expect(t({ redirectHost: 'shop.acme.test' })).toBe('http://shop.acme.test:3000/products/x?ref=1');
  });
  it('never redirects a preview, the primary itself, or without a path', () => {
    expect(t({ preview: true })).toBeNull();
    expect(t({ requestHost: 'shop.acme.com' })).toBeNull();
    expect(t({ path: null })).toBeNull();
    expect(t({ redirectHost: null })).toBeNull();
  });
  it('never redirects /api/*', () => {
    expect(t({ path: '/api/cart-summary' })).toBeNull();
    expect(t({ path: '/api?x=1' })).toBeNull();
    expect(t({ path: '/apiary' })).toBe('https://shop.acme.com/apiary');
  });
  it('ignores invalid redirect hosts and unsafe paths (open redirect, S46)', () => {
    expect(t({ redirectHost: 'https://evil.com' })).toBeNull();
    expect(t({ redirectHost: 'evil.com/x' })).toBeNull();
    expect(t({ path: '//evil.com/x' })).toBeNull();
    expect(t({ path: '/\\evil.com' })).toBeNull();
    expect(t({ path: 'evil.com' })).toBeNull();
    expect(t({ path: '/a\r\nLocation: x' })).toBeNull();
    // A forged ?next= is just part of the query on the primary.
    expect(t({ path: '/?next=https://evil.com' })).toBe('https://shop.acme.com/?next=https://evil.com');
  });
});

describe('redirectablePath', () => {
  it('GET/HEAD pages only', () => {
    expect(redirectablePath('GET', '/products/x', '?ref=1')).toBe('/products/x?ref=1');
    expect(redirectablePath('HEAD', '/', '')).toBe('/');
    expect(redirectablePath('POST', '/checkout', '')).toBeNull();
    expect(redirectablePath('GET', '/api/availability/x', '')).toBeNull();
    expect(redirectablePath('GET', '/robots.txt', '')).toBe('/robots.txt');
  });
});

describe('proxy: internal path header', () => {
  const fwd = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

  it('writes path + query for GET page requests and overwrites a client value', () => {
    const res = proxy(new NextRequest('http://placeholder/products/x?ref=1', { headers: { host: 'acme.localhost', [STOREFRONT_PATH_HEADER]: '//evil.com' } }));
    expect(fwd(res, STOREFRONT_PATH_HEADER)).toBe('/products/x?ref=1');
    expect(fwd(res, STOREFRONT_HOST_HEADER)).toBe('acme.localhost');
  });

  it('drops a client value on POST (Server Actions) and /api/*', () => {
    for (const [url, method] of [
      ['http://placeholder/checkout', 'POST'],
      ['http://placeholder/api/cart-summary', 'GET'],
    ] as const) {
      const res = proxy(new NextRequest(url, { method, headers: { host: 'acme.localhost', [STOREFRONT_PATH_HEADER]: '/x' } }));
      expect(fwd(res, STOREFRONT_PATH_HEADER)).toBeNull();
      // Next lists the overridden request headers; the deleted one must not be forwarded.
      expect(res.headers.get('x-middleware-override-headers') ?? '').not.toContain(STOREFRONT_PATH_HEADER);
    }
  });
});

describe('storefront config + redirects', () => {
  const fetchMock = vi.fn();
  let n = 0;
  const host = () => `r${++n}.storeplix.test`;
  const respond = (store: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    fetchMock.mockImplementation(async () => Response.json({ data: { ...base, ...extra, store: { ...base.store, ...store } } }));
  const setRequest = (h: string, path: string | null) => {
    req.headers = new Headers({ host: h, [STOREFRONT_HOST_HEADER]: h, ...(path ? { [STOREFRONT_PATH_HEADER]: path } : {}) });
  };

  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'k');
    vi.stubEnv('STOREFRONT_LOCAL_PORT', '3000');
    vi.stubGlobal('fetch', fetchMock);
    previewToken = null;
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('schema: redirect_host missing → null, valid → host, invalid → null', async () => {
    for (const [input, expected] of [
      [undefined, null],
      [null, null],
      ['shop.acme.com', 'shop.acme.com'],
      ['https://evil.com/x', null],
      ['shop.acme.com:444', null],
    ] as const) {
      respond(input === undefined ? {} : { redirect_host: input });
      const res = await getStorefrontConfig(host(), null);
      if (res.status !== 'found') throw new Error('expected found');
      expect(res.config.store.redirect_host).toBe(expected);
    }
  });

  it('schema: a redirect to the request host itself or for a preview is dropped', async () => {
    const h = host();
    respond({ redirect_host: h });
    const self = await getStorefrontConfig(h, null);
    expect(self.status === 'found' && self.config.store.redirect_host).toBeNull();

    respond({ redirect_host: 'shop.acme.com' }, { preview: true });
    const pv = await getStorefrontConfig(host(), 'tok');
    expect(pv.status === 'found' && pv.config.preview).toBe(true);
    expect(pv.status === 'found' && pv.config.store.redirect_host).toBeNull();
  });

  it('page request on a non-primary host → 308 to the same path + query on the primary', async () => {
    respond({ redirect_host: 'shop-1.localhost', primary_host: 'shop-1.localhost' });
    setRequest(host(), '/products/x?ref=1');
    await expect(requireCurrentStore()).rejects.toMatchObject({ url: 'http://shop-1.localhost:3000/products/x?ref=1', status: 308 });
  });

  it('no redirect without redirect_host (primary, platform host with platform primary)', async () => {
    respond({ redirect_host: null, primary_host: 'demo.localhost' });
    setRequest('demo.localhost', '/');
    await expect(requireCurrentStore()).resolves.toMatchObject({ host: 'demo.localhost' });
  });

  it('no redirect for POST / Server Actions (no path header)', async () => {
    respond({ redirect_host: 'shop.acme.com' });
    setRequest(host(), null);
    await expect(requireCurrentStore()).resolves.toMatchObject({ mode: 'live' });
  });

  it('draft stores follow the API: redirect when set (Coming soon then shows on the primary)', async () => {
    respond({ status: 'draft', redirect_host: 'shop.acme.com' });
    setRequest(host(), '/');
    await expect(requireCurrentStore()).rejects.toMatchObject({ url: 'https://shop.acme.com/', status: 308 });
  });

  it('robots.txt and sitemap.xml on a non-primary host → 301 to the primary', async () => {
    respond({ redirect_host: 'shop.acme.com' });
    const h = host();
    setRequest(h, '/robots.txt');
    const r = await robots.GET();
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://shop.acme.com/robots.txt');
    setRequest(h, '/sitemap.xml');
    const s = await sitemap.GET();
    expect(s.status).toBe(301);
    expect(s.headers.get('location')).toBe('https://shop.acme.com/sitemap.xml');
  });

  it('robots.txt on the primary is served with the primary Sitemap: line', async () => {
    respond({ redirect_host: null, primary_host: 'shop.acme.com' });
    setRequest('shop.acme.com', '/robots.txt');
    const r = await robots.GET();
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Sitemap: https://shop.acme.com/sitemap.xml');
  });

  it('unknown hosts keep the 404 behaviour', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    setRequest(host(), '/robots.txt');
    expect((await robots.GET()).status).toBe(404);
    await expect(requireCurrentStore()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
