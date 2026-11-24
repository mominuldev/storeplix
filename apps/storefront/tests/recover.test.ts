import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PHASE-8-6 P86-16 / §10.6 `/r/{code}` cart-restore handler: valid → new `sp_cart` + 303 /checkout, a line with an issue
// → 303 /cart, invalid / expired / API down / malformed → 303 / without a cookie; no-store + no-referrer; HEAD never
// creates a cart; the proxy treats `/r/` as private (no-store, no Referer).

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { GET, HEAD } = await import('@/app/r/[code]/route');
const { routeRequest, isPrivateCommercePath } = await import('@/proxy');

const CODE = 'Ab3dE5gH7k';
const NEW_TOKEN = 'N'.repeat(43);
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function open(code = CODE, headers: Record<string, string> = { 'x-storeplix-host': 'mugdho.storeplix.com' }) {
  return GET(new NextRequest(`http://mugdho.storeplix.com/r/${code}`, { headers }), { params: Promise.resolve({ code }) });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /r/{code}', () => {
  it('valid: POSTs the code, sets sp_cart to the NEW token and 303s to /checkout', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { cart_token: NEW_TOKEN, next: 'checkout' } }));
    const res = await open();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.cookies.get('sp_cart')!;
    expect(cookie.value).toBe(NEW_TOKEN);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('http://api.test/api/v1/storefront/carts/recover');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: CODE });
    expect(headers['X-Storefront-Host']).toBe('mugdho.storeplix.com');
    expect(headers['X-Cart-Token']).toBeUndefined();
  });

  it('a line with an issue: 303 /cart with the restored cart', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { cart_token: NEW_TOKEN, next: 'cart' } }));
    const res = await open();
    expect(res.headers.get('location')).toBe('/cart');
    expect(res.cookies.get('sp_cart')?.value).toBe(NEW_TOKEN);
  });

  it('secure cookie in production on a real host', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    fetchMock.mockResolvedValue(json(201, { data: { cart_token: NEW_TOKEN, next: 'checkout' } }));
    expect((await open()).cookies.get('sp_cart')).toMatchObject({ secure: true });
  });

  it.each([
    ['invalid / expired / stopped (404 recovery_link_invalid)', () => Promise.resolve(json(404, { error: { code: 'recovery_link_invalid', message: 'x' } }))],
    ['rate limited', () => Promise.resolve(json(429, { error: { code: 'rate_limited', message: 'x' } }))],
    ['API down', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['malformed token in the answer', () => Promise.resolve(json(201, { data: { cart_token: 'short', next: 'checkout' } }))],
  ])('%s → 303 / without a cookie', async (_name, answer) => {
    fetchMock.mockImplementation(answer);
    const res = await open();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.cookies.get('sp_cart')).toBeUndefined();
  });

  it('a malformed code or a missing tenant host never reaches the API', async () => {
    for (const res of [await open('short'), await open('Ab3dE5gH7k!'), await open(CODE, {})]) {
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HEAD (link previews) creates no cart', async () => {
    const res = HEAD();
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('proxy', () => {
  it('/r/ is private: no-store and no Referer', () => {
    expect(isPrivateCommercePath('/r/Ab3dE5gH7k')).toBe(true);
    expect(isPrivateCommercePath('/returns')).toBe(false);
    const res = routeRequest(new NextRequest('http://demo.localhost/r/Ab3dE5gH7k', { headers: { host: 'demo.localhost' } }));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
