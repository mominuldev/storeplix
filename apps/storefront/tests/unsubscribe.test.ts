import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorefrontApi from '@/lib/storefront-api';
import type { UnsubscribeResult } from '@/lib/storefront-api';

// PHASE-8-5 §8.6 storefront unsubscribe (P85-QA-6): page states (valid / unsubscribed / invalid / test / error), the
// `/u/{code}/change` form handler (303 back, origin check), the RFC 8058 one-click handler and the two API functions.

const status = vi.fn<(host: string, code: string, ip: string | null) => Promise<UnsubscribeResult>>();
const post = vi.fn<(host: string, code: string, action: string, ip: string | null, oneClick?: boolean) => Promise<UnsubscribeResult>>();

vi.mock('@/lib/storefront-api', async (orig) => ({
  ...(await orig<typeof StorefrontApi>()),
  getUnsubscribeStatus: (...a: [string, string, string | null]) => status(...a),
  postUnsubscribe: (...a: [string, string, string, string | null, boolean?]) => post(...a),
}));
vi.mock('@/lib/commerce-api', () => ({ getClientIp: async () => null }));
vi.mock('@/lib/store', () => ({
  findCurrentStore: async () => ({ host: 'mugdho.storeplix.com', mode: 'coming_soon', config: { store: { name: 'Mugdho Fashion' } } }),
}));

const { default: Page } = await import('@/app/u/[code]/page');
const { POST: change } = await import('@/app/u/[code]/change/route');
const { POST: oneClick } = await import('@/app/u/[code]/one-click/route');
const { sameOrigin } = await import('@/app/u/[code]/origin');
const realApi = await vi.importActual<typeof StorefrontApi>('@/lib/storefront-api');

const CODE = 'Ab3dE5gH7k';
const found = (o: Partial<{ status: 'subscribed' | 'unsubscribed'; is_test: boolean; channel: 'sms' | 'email' }> = {}): UnsubscribeResult => ({
  status: 'found',
  data: { channel: 'sms', masked_address: '+880 17•• •••123', status: 'subscribed', is_test: false, store_name: 'Mugdho Fashion', ...o },
});

async function render(code = CODE, e?: string) {
  const el = await Page({ params: Promise.resolve({ code }), searchParams: Promise.resolve(e ? { e } : {}) });
  return renderToStaticMarkup(el);
}

afterEach(() => {
  status.mockReset();
  post.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('/u/{code} page states', () => {
  it('valid + subscribed: who/what/where and an Unsubscribe form posting to /change', async () => {
    status.mockResolvedValue(found());
    const html = await render();
    expect(html).toContain('data-sp-unsubscribe="subscribed"');
    expect(html).toContain('You get SMS from Mugdho Fashion at +880 17•• •••123.');
    expect(html).toContain('<form action="/u/Ab3dE5gH7k/change" method="post">');
    expect(html).toMatch(/value="unsubscribe"[^>]*name="action">Unsubscribe</);
    expect(status).toHaveBeenCalledWith('mugdho.storeplix.com', CODE, null);
  });

  it('unsubscribed: confirmation and Subscribe again', async () => {
    status.mockResolvedValue(found({ status: 'unsubscribed', channel: 'email' }));
    const html = await render();
    expect(html).toContain('You’re unsubscribed');
    expect(html).toContain('You won’t get offers from Mugdho Fashion by email.');
    expect(html).toMatch(/value="resubscribe"[^>]*name="action">Subscribe again</);
  });

  it('invalid: no button', async () => {
    status.mockResolvedValue({ status: 'invalid' });
    const html = await render('nope');
    expect(html).toContain('This link isn’t valid');
    expect(html).not.toContain('<form');
  });

  it('test code: "This was a test message. Nothing changed." with no button', async () => {
    status.mockResolvedValue(found({ is_test: true }));
    const html = await render();
    expect(html).toContain('This was a test message');
    expect(html).toContain('Nothing changed.');
    expect(html).not.toContain('<form');
  });

  it('a failed change (?e=1) and an API error are explained', async () => {
    status.mockResolvedValue(found());
    expect(await render(CODE, '1')).toContain('That didn’t go through');
    status.mockResolvedValue({ status: 'error', code: 503 });
    expect(await render()).toContain('Something went wrong');
  });
});

const host = 'mugdho.storeplix.com';
const form = (action: string, headers: Record<string, string> = {}) =>
  change(
    new Request(`http://${host}/u/${CODE}/change`, {
      method: 'POST',
      headers: { 'x-storeplix-host': host, origin: `http://${host}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ action }).toString(),
    }) as never,
    { params: Promise.resolve({ code: CODE }) },
  );

describe('POST /u/{code}/change', () => {
  it('posts the action and answers 303 back to the page (P85-QA-2: no in-place render)', async () => {
    post.mockResolvedValue(found({ status: 'unsubscribed' }));
    const res = await form('unsubscribe');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/u/${CODE}`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(post).toHaveBeenCalledWith(host, CODE, 'unsubscribe', null);
  });

  it('resubscribe; API errors come back with ?e=1', async () => {
    post.mockResolvedValue({ status: 'error', code: 429 });
    const res = await form('resubscribe');
    expect(res.headers.get('location')).toBe(`/u/${CODE}?e=1`);
    expect(post).toHaveBeenCalledWith(host, CODE, 'resubscribe', null);
  });

  it('refuses a cross-site post and junk actions', async () => {
    expect((await form('unsubscribe', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await form('unsubscribe', { origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await form('delete_everything')).headers.get('location')).toBe(`/u/${CODE}?e=1`);
    expect(post).not.toHaveBeenCalled();
  });

  it('origin rule', () => {
    expect(sameOrigin(null, host)).toBe(true);
    // The page is no-referrer, so its own form posts with `Origin: null` + `Sec-Fetch-Site: same-origin`.
    expect(sameOrigin('null', host, 'same-origin')).toBe(true);
    expect(sameOrigin('null', host, 'cross-site')).toBe(false);
    expect(sameOrigin(`http://${host}`, host, 'same-site')).toBe(false);
    expect(sameOrigin('http://mugdho.storeplix.com:3010', host)).toBe(true);
    expect(sameOrigin('https://other.storeplix.com', host)).toBe(false);
  });
});

describe('POST /u/{code}/one-click (RFC 8058)', () => {
  const click = () =>
    oneClick(new Request(`http://${host}/u/${CODE}/one-click`, { method: 'POST', headers: { 'x-storeplix-host': host } }) as never, {
      params: Promise.resolve({ code: CODE }),
    });

  it('forwards one_click and answers 200 empty; unknown code 404', async () => {
    post.mockResolvedValue(found({ status: 'unsubscribed' }));
    const res = await click();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(post).toHaveBeenCalledWith(host, CODE, 'unsubscribe', null, true);
    post.mockResolvedValue({ status: 'invalid' });
    expect((await click()).status).toBe(404);
  });
});

describe('storefront-api unsubscribe functions', () => {
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_API_KEY', 'k');
    vi.stubEnv('STOREFRONT_API_URL', 'http://api.test');
  });

  it('malformed codes never reach the API; 404 → invalid; 429 → error; 200 is validated', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await realApi.getUnsubscribeStatus(host, 'bad/../x', null)).toEqual({ status: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'unsubscribe_link_invalid' } }), { status: 404 }));
    expect(await realApi.getUnsubscribeStatus(host, CODE, null)).toEqual({ status: 'invalid' });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect(await realApi.postUnsubscribe(host, CODE, 'unsubscribe', null)).toEqual({ status: 'error', code: 429 });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: (found() as { data: unknown }).data }), { status: 200 }));
    expect(await realApi.postUnsubscribe(host, CODE, 'unsubscribe', '1.2.3.4', true)).toEqual(found());

    const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/storefront\/unsubscribe\/Ab3dE5gH7k$/);
    expect(JSON.parse(String(init.body))).toEqual({ action: 'unsubscribe', one_click: true });
    expect((init.headers as Record<string, string>)['X-Storefront-Host']).toBe(host);
    expect((init.headers as Record<string, string>)['X-Storefront-Client-Ip']).toBe('1.2.3.4');
  });
});
