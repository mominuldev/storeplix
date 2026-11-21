import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigRequest } from '@/lib/config-request';
import { getStorefrontConfig } from '@/lib/storefront-api';
import { storeMode } from '@/lib/store-mode';

const env = { apiUrl: 'http://api', apiKey: 'k', revalidateSeconds: 60 };

describe('buildConfigRequest: shared cache vs preview bypass', () => {
  it('public requests use the shared tag cache and never send a preview header', () => {
    const { url, init } = buildConfigRequest('demo.localhost', null, env);
    expect(url).toBe('http://api/api/v1/storefront/config');
    expect(init.next).toEqual({ tags: ['store:demo.localhost'], revalidate: 60 });
    expect(init.cache).toBeUndefined();
    expect(init.headers).not.toHaveProperty('X-Storefront-Preview');
  });

  it('preview requests bypass the cache entirely (no-store, no tags) and forward the token', () => {
    const { init } = buildConfigRequest('demo.localhost', 'tok', env);
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
    expect(init.headers).toMatchObject({ 'X-Storefront-Preview': 'tok', 'X-Storefront-Host': 'demo.localhost' });
  });
});

function apiPayload(store: Record<string, unknown>, preview: unknown) {
  return {
    data: {
      store: { id: '01J', name: 'Demo', slug: 'demo', currency: 'BDT', logo_url: null, favicon_url: null, ...store },
      preview,
      theme: null,
      seo: { title: 'Demo', description: null },
    },
  };
}

describe('getStorefrontConfig', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'test-key');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses no-store + preview header when a cookie token is present', async () => {
    fetchMock.mockResolvedValue(Response.json(apiPayload({ status: 'draft' }, true)));
    const res = await getStorefrontConfig('a.localhost', 'tok');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.cache).toBe('no-store');
    expect(init.headers['X-Storefront-Preview']).toBe('tok');
    expect(res.status === 'found' && res.config.preview).toBe(true);
  });

  it('ignores preview:true from the API when no token was sent', async () => {
    fetchMock.mockResolvedValue(Response.json(apiPayload({ status: 'draft' }, true)));
    const res = await getStorefrontConfig('b.localhost', null);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.next.tags).toEqual(['store:b.localhost']);
    expect(res.status === 'found' && res.config.preview).toBe(false);
  });

  it('treats unknown statuses as draft', async () => {
    fetchMock.mockResolvedValue(Response.json(apiPayload({ status: 'weird' }, false)));
    const res = await getStorefrontConfig('c.localhost', null);
    expect(res.status === 'found' && res.config.store.status).toBe('draft');
  });
});

describe('storeMode', () => {
  const cfg = (status: 'active' | 'draft', preview: boolean) => ({ store: { status } as never, preview });
  it.each([
    ['draft', false, 'coming_soon'],
    ['draft', true, 'preview'],
    ['active', false, 'live'],
    ['active', true, 'preview'],
  ] as const)('%s + preview=%s -> %s', (status, preview, mode) => {
    expect(storeMode(cfg(status, preview))).toBe(mode);
  });
});
