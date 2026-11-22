import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- framework mocks: a cookie jar, request headers, refresh() ----
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

const store = { mode: 'live' as 'live' | 'preview' | 'coming_soon', status: 'active' };
vi.mock('@/lib/store', () => ({
  findCurrentStore: async () => ({ host: 'demo.localhost', mode: store.mode, config: { store: { status: store.status } } }),
}));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => 'preview-token' }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { addToCart, placeOrder, updateLine, applyDiscountLink, trackOrder, buyNow } = await import('@/app/actions/commerce');
const routeModules = {
  availability: await import('@/app/api/availability/[slug]/route'),
  summary: await import('@/app/api/cart-summary/route'),
  quote: await import('@/app/api/shipping-quote/route'),
};

const TOKEN = 'T'.repeat(43);
const cart = (over: Record<string, unknown> = {}) => ({
  lines: [], lines_count: 1, items_count: 1, currency: 'BDT', coupon: null, subtotal_amount: 1000, discount_amount: 0, savings_amount: 0,
  estimated_total_amount: 1000, free_delivery: null, can_checkout: true, ...over,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const sent = (i = 0) => ({ url: fetchMock.mock.calls[i]![0], init: fetchMock.mock.calls[i]![1], headers: fetchMock.mock.calls[i]![1].headers as Record<string, string> });

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  const values: Record<string, string> = {
    name: 'Ayesha Rahman', phone: '01712345678', email: '', district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: '', address_line: 'House 12, Road 7',
    landmark: '', label: 'home', customer_note: '', idempotency_key: '11111111-2222-3333-4444-555555555555', expected_total_amount: '8000', ...over,
  };
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const idle = { status: 'idle' as const, message: null, fieldErrors: {}, idempotencyKey: '11111111-2222-3333-4444-555555555555' };

beforeEach(() => {
  jar.clear();
  store.mode = 'live';
  store.status = 'active';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('cart actions and sp_cart', () => {
  it('stores the one-time cart token in an httpOnly, Lax, host-only cookie and never returns it', async () => {
    fetchMock.mockResolvedValue(json(201, { data: cart(), meta: { cart_token: TOKEN } }));
    const r = await addToCart({ variantId: '01jvar00000000000000000001', quantity: 2 });
    expect(r).toEqual({ ok: true, linesCount: 1, notices: [] });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const c = jar.get('sp_cart')!;
    expect(c.value).toBe(TOKEN);
    expect(c.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 });
    expect(c.opts).not.toHaveProperty('domain');
    expect(sent().url).toBe('http://api.test/api/v1/storefront/cart/items');
    expect(sent().headers['X-Storefront-Key']).toBe('test-key');
    expect(JSON.parse(String(sent().init.body))).toEqual({ variant_id: '01jvar00000000000000000001', quantity: 2 });
  });

  it('forwards the existing token and validates input before calling the API', async () => {
    jar.set('sp_cart', { value: TOKEN });
    expect(await addToCart({ variantId: 'x', quantity: 100 })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(json(200, { data: cart(), meta: {} }));
    await addToCart({ variantId: 'v1', quantity: 1 });
    expect(sent().headers['X-Cart-Token']).toBe(TOKEN);
  });

  it('shows the API out-of-stock text', async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: 'out_of_stock', message: 'Out of stock', details: { quantity: ['Only 3 left.'] } } }));
    expect(await addToCart({ variantId: 'v1', quantity: 5 })).toEqual({ ok: false, message: 'Only 3 left.' });
  });

  it('clears sp_cart on 404 cart_not_found', async () => {
    jar.set('sp_cart', { value: TOKEN });
    fetchMock.mockResolvedValue(json(404, { error: { code: 'cart_not_found', message: 'Gone' } }));
    const r = await updateLine({ itemId: 'line1', quantity: 2 });
    expect(r.ok).toBe(false);
    expect(jar.has('sp_cart')).toBe(false);
  });

  it('buy now sends the shopper to checkout', async () => {
    fetchMock.mockResolvedValue(json(201, { data: cart(), meta: { cart_token: TOKEN } }));
    expect(await buyNow({ variantId: 'v1', quantity: 1 })).toMatchObject({ ok: true, redirect: '/checkout' });
  });

  it('refuses on a draft store without preview (Coming soon)', async () => {
    store.mode = 'coming_soon';
    expect(await addToCart({ variantId: 'v1', quantity: 1 })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('placeOrder', () => {
  beforeEach(() => jar.set('sp_cart', { value: TOKEN }));

  it('places the order: Idempotency-Key + expected total, sets sp_order, clears sp_cart', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { order: { number: 'DE-1001' }, confirmation_token: 'c'.repeat(43) } }));
    // parseCheckoutResult needs a full order; give it one.
    fetchMock.mockResolvedValue(
      json(201, {
        data: {
          confirmation_token: 'c'.repeat(43),
          order: {
            number: 'DE-1001', status: 'pending', payment_method: 'cod', placed_at: '2026-11-22T10:00:00Z', customer_name: 'Ayesha', customer_phone: '8801712345678',
            shipping_address: { division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-mirpur', thana: 'Mirpur', area: null, address_line: 'House 12', landmark: null, label: 'home' },
            lines: [], coupon_code: null, subtotal_amount: 1000, discount_amount: 0, shipping_amount: 7000, total_amount: 8000, due_amount: 8000, currency: 'BDT', delivery: { zone_name: 'Inside Dhaka', min_days: 1, max_days: 2 },
          },
        },
      }),
    );
    const r = await placeOrder(idle, form());
    expect(r).toMatchObject({ status: 'redirect', redirect: '/checkout/thank-you' });
    expect(sent().headers['Idempotency-Key']).toBe(idle.idempotencyKey);
    expect(sent().headers['X-Cart-Token']).toBe(TOKEN);
    const body = JSON.parse(String(sent().init.body));
    expect(body).toMatchObject({ expected_total_amount: 8000, payment_method: 'cod', contact: { phone: '8801712345678' } });
    expect(jar.get('sp_order')!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', maxAge: 86400 });
    expect(jar.has('sp_cart')).toBe(false);
  });

  it('keeps the same key across a network failure retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const first = await placeOrder(idle, form());
    expect(first.status).toBe('error');
    expect(first.idempotencyKey).toBe(idle.idempotencyKey);
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'idempotency_key_in_use', message: 'busy' } }));
    const second = await placeOrder(first, form({ idempotency_key: first.idempotencyKey }));
    expect(second.idempotencyKey).toBe(idle.idempotencyKey);
    expect(sent(1).headers['Idempotency-Key']).toBe(idle.idempotencyKey);
  });

  it('checkout_changed: shows the new total and rotates the key', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'checkout_changed', message: 'Changed', details: { expected_total_amount: ['The total changed to ৳ 3,900. Check your order and place it again.'] } } }));
    const r = await placeOrder(idle, form());
    expect(r.status).toBe('changed');
    expect(r.message).toBe('The total changed to ৳ 3,900. Check your order and place it again.');
    expect(r.idempotencyKey).not.toBe(idle.idempotencyKey);
    expect(jar.has('sp_cart')).toBe(true);
  });

  it('out_of_stock sends the shopper back to the bag', async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: 'out_of_stock', message: 'x', details: { 'items.0.quantity': ['Only 1 left.'] } } }));
    expect(await placeOrder(idle, form())).toMatchObject({ status: 'redirect', redirect: '/cart?changed=stock' });
  });

  it('maps validation details to fields', async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: 'validation_failed', message: 'x', details: { 'shipping_address.thana_code': ['This thana is not in Dhaka.'] } } }));
    expect(await placeOrder(idle, form())).toMatchObject({ status: 'invalid', fieldErrors: { thana_code: 'This thana is not in Dhaka.' } });
  });

  it('validates locally first (no API call)', async () => {
    const r = await placeOrder(idle, form({ phone: '123' }));
    expect(r).toMatchObject({ status: 'invalid', fieldErrors: { phone: 'Enter a Bangladeshi mobile number (01XXXXXXXXX).' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preview of a draft store shows the not-live message', async () => {
    store.mode = 'preview';
    fetchMock.mockResolvedValue(json(409, { error: { code: 'store_not_live', message: "Your shop isn't live yet. Orders open after you go live." } }));
    const r = await placeOrder(idle, form());
    expect(r).toMatchObject({ status: 'error', message: "Your shop isn't live yet. Orders open after you go live." });
    expect(sent().headers['X-Storefront-Preview']).toBe('preview-token');
  });
});

describe('discount link and tracking', () => {
  it('without a cart keeps the code for the first add and flashes a toast', async () => {
    await applyDiscountLink('winter15');
    expect(jar.get('sp_coupon')!.value).toBe('WINTER15');
    expect(JSON.parse(jar.get('sp_flash')!.value)).toEqual({ tone: 'ok', message: 'Code WINTER15 will apply at checkout.' });
    // The pending code is attached when the cart is created.
    fetchMock.mockResolvedValueOnce(json(201, { data: cart(), meta: { cart_token: TOKEN } })).mockResolvedValueOnce(json(200, { data: cart(), meta: {} }));
    const r = await addToCart({ variantId: 'v1', quantity: 1 });
    expect(sent(1).url).toBe('http://api.test/api/v1/storefront/cart/coupon');
    expect(JSON.parse(String(sent(1).init.body))).toEqual({ code: 'WINTER15' });
    expect(r).toMatchObject({ ok: true, notices: ['Code WINTER15 will apply at checkout.'] });
    expect(jar.has('sp_coupon')).toBe(false);
  });

  it('with a cart applies the code and reports API errors', async () => {
    jar.set('sp_cart', { value: TOKEN });
    fetchMock.mockResolvedValue(json(422, { error: { code: 'coupon_invalid', message: 'x', details: { code: ['This code has expired.'] } } }));
    await applyDiscountLink('OLD10');
    expect(JSON.parse(jar.get('sp_flash')!.value)).toEqual({ tone: 'error', message: 'Code OLD10: This code has expired.' });
  });

  it('tracking: identical not-found text, phone normalised in the body', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
    const fd = new FormData();
    fd.set('number', 'de-1001');
    fd.set('phone', '01712-345678');
    const r = await trackOrder({ status: 'idle' }, fd);
    expect(r).toMatchObject({ status: 'not_found' });
    expect(JSON.parse(String(sent().init.body))).toEqual({ number: 'DE-1001', phone: '8801712345678' });
    expect(sent().url).toBe('http://api.test/api/v1/storefront/orders/track');
  });
});

describe('route handlers are read-only (S12)', () => {
  it.each(Object.entries(routeModules))('%s exports GET only', (_name, mod) => {
    const methods = Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k));
    expect(methods).toEqual(['GET']);
  });

  it('cart-summary returns counts with private, no-store and no token', async () => {
    jar.set('sp_cart', { value: TOKEN });
    fetchMock.mockResolvedValue(json(200, { data: cart({ lines_count: 3, items_count: 5 }), meta: {} }));
    const res = await routeModules.summary.GET();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ data: { lines_count: 3, items_count: 5 } });
    expect(text).not.toContain(TOKEN);
  });
});
