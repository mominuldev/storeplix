import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, { value: string; opts?: Record<string, unknown> }>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    has: (n: string) => jar.has(n),
    set: (n: string, value: string, opts?: Record<string, unknown>) => void jar.set(n, { value, opts }),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => new Headers({ host: 'demo.localhost' }),
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
const store = { mode: 'live' as 'live' | 'preview' };
vi.mock('@/lib/store', () => ({
  findCurrentStore: async () => ({ host: 'demo.localhost', mode: store.mode, config: { store: { status: 'active' } } }),
}));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => null }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { trackOrder } = await import('@/app/actions/commerce');
const { getStorefrontConfig } = await import('@/lib/storefront-api');

const ACCESS = 'acc.'.repeat(8);
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const tracking = (messages: unknown) => ({
  number: 'BG-1001', status: 'confirmed', placed_at: '2026-11-28T10:00:00Z', shipping: { district: 'Dhaka', thana: 'Dhanmondi' }, lines: [],
  total_amount: 100, due_amount: 100, currency: 'BDT', timeline: [], shipment: null, messages,
});
const form = () => {
  const fd = new FormData();
  fd.set('number', 'bg-1001');
  fd.set('phone', '01712345678');
  return fd;
};

beforeEach(() => {
  jar.clear();
  store.mode = 'live';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('trackOrder + order Messages (§10)', () => {
  it('keeps the access token in an httpOnly cookie and returns counts only', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: tracking({ enabled: true, access_token: ACCESS, unread_count: 2, reply_time: 'hour' }) }));
    const r = await trackOrder({ status: 'idle' }, form());
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.tracking.messages).toEqual({ unread_count: 2, reply_time: 'hour' });
    expect(JSON.stringify(r)).not.toContain(ACCESS);
    const c = jar.get('sp_order_access');
    expect(c?.value).toBe(`BG-1001~${ACCESS}`);
    expect(c?.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  });

  it('channel off → no card, no cookie', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: tracking(null) }));
    const r = await trackOrder({ status: 'idle' }, form());
    expect(r.status === 'found' && r.tracking.messages).toBeNull();
    expect(jar.has('sp_order_access')).toBe(false);
  });
});

describe('StorefrontConfig.inbox (§9.1)', () => {
  const base = {
    store: { id: '01J', name: 'Demo', slug: 'demo', status: 'active', currency: 'BDT', logo_url: null, favicon_url: null },
    preview: false, theme: null, seo: { title: 'Demo', description: null },
    inbox: { web_chat: { enabled: true, reply_time: 'minutes', hours: null, greeting: null }, order_messages: true },
  };
  it('parses the channels for a live store', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: base }));
    const r = await getStorefrontConfig('inbox-live.localhost', null);
    expect(r.status === 'found' && r.config.inbox?.web_chat?.reply_time).toBe('minutes');
  });
  it('never exposes the widget on a draft store even if the API sent it', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { ...base, store: { ...base.store, status: 'draft' } } }));
    const r = await getStorefrontConfig('inbox-draft.localhost', null);
    expect(r.status === 'found' && r.config.inbox).toBeNull();
  });
  it('older APIs without `inbox` → null', async () => {
    const { inbox: _omit, ...old } = base;
    fetchMock.mockResolvedValue(Response.json({ data: old }));
    const r = await getStorefrontConfig('inbox-old.localhost', null);
    expect(r.status === 'found' && r.config.inbox).toBeNull();
  });
});
