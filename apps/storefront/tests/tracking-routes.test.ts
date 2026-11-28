import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CurrentStore, StoreMode } from '@/lib/store';
import type { StorefrontTrackingConfig } from '@storeplix/types';
import { resolveStoreTheme } from '@/themes/registry';

/**
 * PHASE-8-9D §16 SF: the beacon route (origin, key never exposed, gating), checkout context, `?sp_test=` in the proxy,
 * store-layout mount (byte-identical without tracking, S349; nothing on Coming soon/preview; consent bar) and the
 * site-verification meta. The API is mocked at fetch.
 */

// ---- framework mocks ----
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    has: (n: string) => jar.has(n),
    set: (n: string, value: string) => void jar.set(n, value),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => new Headers({ host: 'demo.localhost', 'user-agent': 'Mozilla/5.0 Shopper', 'x-forwarded-for': '203.0.113.9' }),
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  permanentRedirect: vi.fn(),
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
let current: CurrentStore;
vi.mock('@/lib/store', () => ({ requireCurrentStore: async () => current, findCurrentStore: async () => current }));
vi.mock('@/components/preview-bridge', async () => {
  const { createElement } = await import('react');
  return { PreviewBridge: () => createElement('i', { 'data-bridge': '' }) };
});
vi.mock('@/lib/preview', () => ({ isEmbeddedPreview: async () => false, getPreviewToken: async () => null }));

process.env.STOREFRONT_API_KEY = 'sf-secret-key';
process.env.STOREFRONT_API_URL = 'http://api.test';
process.env.TRUSTED_PROXY = 'true';

const beacon = await import('@/app/api/t/route');
const { routeRequest } = await import('@/proxy');
const { placeOrder } = await import('@/app/actions/commerce');
const { default: StoreLayout, generateMetadata } = await import('@/app/(store)/layout');

const HOST = 'demo.localhost';
const META = '123456789012345';
const GA4 = 'G-ABC123XYZ9';
const TRACKING: StorefrontTrackingConfig = {
  meta_pixel_id: META, ga4_measurement_id: GA4, tiktok_pixel_id: null, wait_for_consent: false, collect: true, currency: 'BDT', site_verification: { google: 'tok_ABCDEFGH12' },
};

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiConfig = (over: { status?: 'active' | 'draft'; tracking?: unknown } = {}) => ({
  data: {
    store: { id: '01J', name: 'Demo', slug: 'demo', status: over.status ?? 'active', currency: 'BDT', logo_url: null, favicon_url: null, primary_host: HOST },
    preview: false,
    seo: { title: 'Demo', description: null, og_image_url: null, noindex: false },
    tracking: 'tracking' in over ? over.tracking : { ...TRACKING, access_token: 'EAAB-never' },
  },
});

beforeEach(() => {
  jar.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// ---------- beacon route ----------
const EVENT = { event_id: '01JEVENT000000000000000001', name: 'view_item', occurred_at: '2026-11-28T10:00:00Z', page_path: '/products/x?email=a@b.c', product_id: '01JPRODUCT0000000000000001', value: 1 };
function beaconReq(body: unknown, headers: Record<string, string> = { origin: `http://${HOST}` }, cookies: Record<string, string> = {}) {
  const h = new Headers({ 'x-storeplix-host': HOST, 'content-type': 'text/plain;charset=UTF-8', 'user-agent': 'UA/1', 'x-forwarded-for': '198.51.100.7', ...headers });
  const c = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (c) h.set('cookie', c);
  return new NextRequest(`http://${HOST}/api/t`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: h });
}
const route = (cfg = apiConfig()) => fetchMock.mockImplementation(async (url) => (url.includes('/storefront/config') ? json(200, cfg) : new Response(null, { status: 202 })));
const beaconCall = () => fetchMock.mock.calls.find(([u]) => u.includes('/tracking/events'));

describe('POST /api/t (beacon, S335)', () => {
  it('forwards valid events server-to-server with the key, IP and cookie context; returns nothing', async () => {
    route();
    const res = await beacon.POST(beaconReq({ events: [EVENT, { ...EVENT, event_id: 'bad' }] }, { origin: `http://${HOST}` }, { _fbp: 'fb.1.1700000000000.1234567890', _ga: 'GA1.1.111.222' }));
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
    expect(JSON.stringify([...res.headers])).not.toContain('sf-secret-key');
    const [url, init] = beaconCall()!;
    expect(url).toBe('http://api.test/api/v1/storefront/tracking/events');
    expect(init.headers).toMatchObject({ 'X-Storefront-Host': HOST, 'X-Storefront-Key': 'sf-secret-key', 'X-Storefront-Client-Ip': '198.51.100.7' });
    expect(JSON.parse(String(init.body))).toEqual({
      events: [{ event_id: EVENT.event_id, name: 'view_item', occurred_at: '2026-11-28T10:00:00.000Z', page_path: '/products/x', product_id: EVENT.product_id }],
      context: { consent: 'not_required', user_agent: 'UA/1', fbp: 'fb.1.1700000000000.1234567890', fbc: null, ga_client_id: '111.222', ga_session_id: null },
    });
  });

  it('refuses cross-origin posts and posts without origin evidence', async () => {
    route();
    expect((await beacon.POST(beaconReq({ events: [EVENT] }, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await beacon.POST(beaconReq({ events: [EVENT] }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await beacon.POST(beaconReq({ events: [EVENT] }, {}))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards nothing for a store without tracking, a draft store, or a waiting shop without Accept', async () => {
    route(apiConfig({ tracking: null }));
    expect((await beacon.POST(beaconReq({ events: [EVENT] }))).status).toBe(204);
    route(apiConfig({ status: 'draft' }));
    expect((await beacon.POST(beaconReq({ events: [EVENT] }))).status).toBe(204);
    route(apiConfig({ tracking: { ...TRACKING, wait_for_consent: true } }));
    expect((await beacon.POST(beaconReq({ events: [EVENT] }))).status).toBe(204);
    expect((await beacon.POST(beaconReq({ events: [EVENT] }, undefined, { sp_consent: 'denied' }))).status).toBe(204);
    expect(beaconCall()).toBeUndefined();
    await beacon.POST(beaconReq({ events: [EVENT] }, undefined, { sp_consent: 'granted' }));
    expect(JSON.parse(String(beaconCall()![1].body)).context.consent).toBe('granted');
  });

  it('empty/garbage bodies and oversize posts never reach the API; API errors are swallowed', async () => {
    route();
    expect((await beacon.POST(beaconReq('nope'))).status).toBe(204);
    expect((await beacon.POST(beaconReq('x'.repeat(17_000)))).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async (url) => (url.includes('/storefront/config') ? json(200, apiConfig()) : Promise.reject(new Error('down'))));
    expect((await beacon.POST(beaconReq({ events: [EVENT] }))).status).toBe(204);
  });
});

// ---------- proxy ?sp_test= ----------
describe('proxy: tracking test mode (§6.3)', () => {
  it('turns ?sp_test= into an httpOnly 30-min cookie and strips the param, no referrer', () => {
    const token = 'eyJzIjoiMDFKIn0.abcdefghijklmnop';
    const res = routeRequest(new NextRequest(`http://${HOST}/products/x?sp_test=${token}&a=1`, { headers: { host: HOST } }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`http://${HOST}/products/x?a=1`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sp_track_test='))!;
    expect(cookie).toContain(token);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=1800/);
  });
  it('a garbage token ends test mode', () => {
    const res = routeRequest(new NextRequest(`http://${HOST}/?sp_test=%3Cscript%3E`, { headers: { host: HOST, cookie: 'sp_track_test=old-token-1234567890' } }));
    expect(res.status).toBe(307);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('sp_track_test='))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

// ---------- layout mount ----------
function makeStore(mode: StoreMode, tracking: StorefrontTrackingConfig | null | undefined): CurrentStore {
  const { theme, config: themeConfig } = resolveStoreTheme(undefined);
  const config: CurrentStore['config'] = {
    store: { id: '01J', name: 'Demo Store', slug: 'demo', status: mode === 'coming_soon' ? 'draft' : 'active', currency: 'BDT', logo_url: null, favicon_url: null, icons: { apple_touch: null, icon_192: null, icon_512: null }, primary_host: HOST },
    contact: { phone: null, email: null, whatsapp: null, support_hours: null },
    social: { facebook: null, instagram: null, youtube: null },
    preview: mode === 'preview',
    commerce: null,
    theme: undefined,
    seo: { title: 'Demo Store', description: 'Desc', og_image_url: null, noindex: false },
    navigation: { main: { title: 'Main menu', items: [] }, footer: { title: 'Shop', items: [] }, help: { title: 'Help', items: [] } },
    media: {},
  };
  if (tracking !== undefined) config.tracking = tracking;
  return { host: HOST, mode, theme, themeConfig, config };
}
const renderLayout = async () => renderToStaticMarkup(await StoreLayout({ children: 'STORE CONTENT' }));

describe('store layout mount (§6.1, S349)', () => {
  it('a shop that connects nothing renders byte-identical HTML and metadata', async () => {
    current = makeStore('live', undefined);
    const before = await renderLayout();
    const metaBefore = await generateMetadata();
    current = makeStore('live', null);
    expect(await renderLayout()).toBe(before);
    expect(await generateMetadata()).toEqual(metaBefore);
    expect(before).not.toMatch(/sp-consent|<script(?! type="application\/ld\+json")/);
    expect(metaBefore).not.toHaveProperty('verification');
  });

  it('server-renders no script tag; the consent bar only while a waiting shop has no decision', async () => {
    current = makeStore('live', TRACKING);
    const on = await renderLayout();
    expect(on).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(on).not.toMatch(/fbevents|gtag|tiktok/);
    expect(on).not.toContain('data-sp-consent-bar');
    current = makeStore('live', { ...TRACKING, wait_for_consent: true });
    const waiting = await renderLayout();
    expect(waiting).toContain('data-sp-consent-bar');
    expect(waiting).toContain('Accept');
    expect(waiting).toContain('Decline');
    jar.set('sp_consent', 'denied');
    expect(await renderLayout()).not.toContain('data-sp-consent-bar');
  });

  it('nothing on Coming soon or preview, even with tracking in the config', async () => {
    for (const mode of ['coming_soon', 'preview'] as const) {
      current = makeStore(mode, { ...TRACKING, wait_for_consent: true });
      expect(await renderLayout()).not.toContain('data-sp-consent-bar');
      expect(await generateMetadata()).not.toHaveProperty('verification');
    }
  });

  it('writes the google-site-verification meta from the validated token', async () => {
    current = makeStore('live', TRACKING);
    expect((await generateMetadata()).verification).toEqual({ google: 'tok_ABCDEFGH12' });
  });
});

// ---------- checkout context ----------
const CART = 'T'.repeat(43);
const KEY = '11111111-2222-3333-4444-555555555555';
const order = {
  number: 'GS-1041', status: 'pending', payment_method: 'cod', placed_at: '2026-11-22T10:00:00Z', customer_name: 'Ayesha Rahman', customer_phone: '8801712345678',
  shipping_address: { division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-mirpur', thana: 'Mirpur', area: null, address_line: 'House 12', landmark: null, label: 'home' },
  lines: [], coupon_code: null, subtotal_amount: 120000, discount_amount: 0, shipping_amount: 7000, total_amount: 127000, due_amount: 127000, currency: 'BDT',
  delivery: { zone_name: 'Inside Dhaka', min_days: 1, max_days: 2 }, payment: null, paid_amount: 0,
};
const checkoutForm = () => {
  const fd = new FormData();
  const v: Record<string, string> = { name: 'Ayesha Rahman', phone: '01712345678', email: '', district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: '', address_line: 'House 12, Road 7', landmark: '', label: 'home', customer_note: '', idempotency_key: KEY, expected_total_amount: '127000', payment_method: 'cod' };
  for (const [k, x] of Object.entries(v)) fd.set(k, x);
  return fd;
};
const idle = { status: 'idle' as const, message: null, fieldErrors: {}, idempotencyKey: KEY };

describe('placeOrder: CheckoutInput.tracking (§5.5)', () => {
  beforeEach(() => {
    jar.set('sp_cart', CART);
    fetchMock.mockResolvedValue(json(201, { data: { order, confirmation_token: 'o'.repeat(43), payment: null } }));
  });

  it('sends the cookie context when the shop has tracking', async () => {
    current = makeStore('live', TRACKING);
    jar.set('_fbp', 'fb.1.1700000000000.1234567890');
    jar.set('_fbc', 'fb.1.1700000000000.IwAR2abc');
    jar.set('_ga', 'GA1.1.123.456');
    expect(await placeOrder(idle, checkoutForm())).toMatchObject({ status: 'redirect' });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.tracking).toEqual({ consent: 'not_required', user_agent: 'Mozilla/5.0 Shopper', fbp: 'fb.1.1700000000000.1234567890', fbc: 'fb.1.1700000000000.IwAR2abc', ga_client_id: '123.456', ga_session_id: null });
  });

  it('sends nothing for a shop without tracking', async () => {
    current = makeStore('live', null);
    jar.set('_fbp', 'fb.1.1700000000000.1234567890');
    await placeOrder(idle, checkoutForm());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).not.toHaveProperty('tracking');
  });
});
