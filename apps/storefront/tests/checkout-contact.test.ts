import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PHASE-8-6 §10.6 / P86-12 checkout contact capture: what is sent on blur (nothing for an invalid phone, no repeats),
// the server action (normalized phone, PUT /storefront/cart/contact with the cart token, never throws, never blocks),
// and the notice under the phone field (en shown, bn ready).

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    has: (n: string) => jar.has(n),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => new Headers({ host: 'demo.localhost' }),
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
const store = { mode: 'live' as 'live' | 'preview' | 'coming_soon' };
vi.mock('@/lib/store', () => ({ findCurrentStore: async () => ({ host: 'demo.localhost', mode: store.mode, config: { store: { status: 'active' } } }) }));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => null }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { saveCheckoutContact } = await import('@/app/actions/commerce');
const { CheckoutForm, CONTACT_NOTICE, contactToSave } = await import('@/themes/modern-commerce/commerce/checkout-form');

const TOKEN = 'T'.repeat(43);
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  jar.clear();
  jar.set('sp_cart', TOKEN);
  store.mode = 'live';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('contactToSave (what a blur sends)', () => {
  const v = (o: Partial<{ phone: string; name: string; email: string }> = {}) => ({ phone: '', name: '', email: '', ...o });

  it('sends nothing until the phone is a valid BD mobile number', () => {
    expect(contactToSave(v({ phone: '' }), null)).toBeNull();
    expect(contactToSave(v({ phone: '0171234' }), null)).toBeNull();
    expect(contactToSave(v({ phone: '01212345678' }), null)).toBeNull();
    expect(contactToSave(v({ phone: '12345678901', name: 'Ayesha' }), null)).toBeNull();
  });

  it('sends the phone, then name/email once given; never the same payload twice', () => {
    const first = contactToSave(v({ phone: ' 01712-345678 ' }), null)!;
    expect(first.payload).toEqual({ phone: '01712-345678' });
    expect(contactToSave(v({ phone: '+8801712345678' }), first.key)).toBeNull();
    const named = contactToSave(v({ phone: '01712345678', name: ' Ayesha ', email: 'A@B.com' }), first.key)!;
    expect(named.payload).toEqual({ phone: '01712345678', name: 'Ayesha', email: 'A@B.com' });
    expect(contactToSave(v({ phone: '01712345678', name: 'Ayesha', email: 'a@b.com' }), named.key)).toBeNull();
  });
});

describe('saveCheckoutContact (server action)', () => {
  it('PUTs the normalized phone + name/email with the cart token and the storefront headers', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(saveCheckoutContact({ phone: '01712-345678', name: ' Ayesha Rahman ', email: 'AYESHA@Mail.com' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('http://api.test/api/v1/storefront/cart/contact');
    expect(init.method).toBe('PUT');
    expect(headers['X-Cart-Token']).toBe(TOKEN);
    expect(headers['X-Storefront-Host']).toBe('demo.localhost');
    expect(JSON.parse(String(init.body))).toEqual({ phone: '8801712345678', name: 'Ayesha Rahman', email: 'ayesha@mail.com' });
  });

  it('drops an invalid email but still saves the phone', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await saveCheckoutContact({ phone: '01812345678', email: 'not-an-email' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ phone: '8801812345678' });
  });

  it('is a no-op for an invalid phone, without a cart, in preview and on a coming-soon shop', async () => {
    await saveCheckoutContact({ phone: '12345' });
    jar.clear();
    await saveCheckoutContact({ phone: '01712345678' });
    jar.set('sp_cart', TOKEN);
    store.mode = 'preview';
    await saveCheckoutContact({ phone: '01712345678' });
    store.mode = 'coming_soon';
    await saveCheckoutContact({ phone: '01712345678' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws or reports: 422, 429, 404 and a network failure all resolve to undefined', async () => {
    for (const res of [
      () => Promise.resolve(new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'x' } }), { status: 422 })),
      () => Promise.resolve(new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), { status: 429 })),
      () => Promise.resolve(new Response(JSON.stringify({ error: { code: 'cart_not_found', message: 'x' } }), { status: 404 })),
      () => Promise.reject(new Error('ECONNREFUSED')),
    ]) {
      fetchMock.mockImplementationOnce(res);
      await expect(saveCheckoutContact({ phone: '01712345678' })).resolves.toBeUndefined();
    }
    // A failed save never clears the cart (checkout goes on as before).
    expect(jar.get('sp_cart')).toBe(TOKEN);
  });

  it('ignores malformed input', async () => {
    await expect(saveCheckoutContact({ phone: 'x'.repeat(500) })).resolves.toBeUndefined();
    await expect(saveCheckoutContact(null as unknown as { phone: string })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('checkout notice', () => {
  it('has the contract copy in English and Bangla', () => {
    expect(CONTACT_NOTICE.en).toBe("If you don't finish, we may text you a reminder. You can opt out any time.");
    expect(CONTACT_NOTICE.bn).toBe('অর্ডার শেষ না করলে আমরা একটি রিমাইন্ডার SMS পাঠাতে পারি। যেকোনো সময় বন্ধ করতে পারবেন।');
  });

  it('renders under the phone field, described by the phone input', () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutForm, {
        geo: null,
        summary: { currency: 'BDT', itemsCount: 1, subtotal: 100_000, discount: 0, estimatedTotal: 100_000, coupon: null, lines: [] },
        idempotencyKey: '11111111-2222-3333-4444-555555555555',
        notLiveMessage: null,
        paymentMethods: ['cod'],
        codAdvance: 'none',
      }),
    );
    expect(html).toContain('If you don&#x27;t finish, we may text you a reminder. You can opt out any time.');
    expect(html).toMatch(/id="phone"[^>]*aria-describedby="phone-hint phone-recovery-notice"/);
    expect(html.indexOf('id="phone-recovery-notice"')).toBeGreaterThan(html.indexOf('id="phone"'));
    expect(html.indexOf('id="phone-recovery-notice"')).toBeLessThan(html.indexOf('id="email"'));
  });
});
