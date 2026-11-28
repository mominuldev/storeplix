import { renderToStaticMarkup } from 'react-dom/server';
import type { PolledStatus } from '@/lib/payments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 5b-2 storefront payments (PHASE-5B-CONTRACT §11, §13 "Storefront"): schemas, placeOrder
 * redirects, retry / COD switch, payment links, the payment-result states, /api/payment-status and
 * shopper-IP forwarding. The API is mocked at fetch.
 */

// ---- framework mocks ----
const jar = new Map<string, { value: string; opts?: Record<string, unknown> }>();
const reqHeaders = { xff: '203.0.113.9' };
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    has: (n: string) => jar.has(n),
    set: (n: string, value: string, opts?: Record<string, unknown>) => void jar.set(n, { value, opts }),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => new Headers({ host: 'demo.localhost', 'x-forwarded-for': reqHeaders.xff }),
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
class RedirectError extends Error {
  digest: string;
  constructor(public url: string) {
    super('NEXT_REDIRECT');
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const storeState = { mode: 'live' as 'live' | 'preview' | 'coming_soon' };
const currentStore = () => ({ host: 'demo.localhost', mode: storeState.mode, config: { store: { status: 'active', name: 'Gallery Shop' }, contact: { whatsapp: null } } });
vi.mock('@/lib/store', () => ({ findCurrentStore: async () => currentStore(), requireCurrentStore: async () => currentStore() }));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => 'preview-token' }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';
process.env.TRUSTED_PROXY = 'true';

const schemas = await import('@/lib/commerce-schemas');
const payments = await import('@/lib/payments');
const { placeOrder, payOrder, payLink } = await import('@/app/actions/commerce');
const statusRoute = await import('@/app/api/payment-status/route');
const { resolvePaymentResult } = await import('@/lib/payment-result');
const PayPage = (await import('@/app/(store)/pay/[token]/page')).default;
const PaymentResultPage = (await import('@/app/(store)/checkout/payment-result/page')).default;
const ThankYouPage = (await import('@/app/(store)/checkout/thank-you/page')).default;
const { isNextRedirect } = await import('@/themes/modern-commerce/commerce/payment-client');

// ---- fixtures ----
const CART = 'T'.repeat(43);
const ORDER_TOKEN = 'o'.repeat(43);
const PAY_ID = '01JPAYMENT00000000000000AB';
const KEY = '11111111-2222-3333-4444-555555555555';
const GATEWAY_URL = 'https://tokenized.sandbox.bka.sh/v2/checkout?paymentId=TR001';

const order = (over: Record<string, unknown> = {}) => ({
  number: 'GS-1041', status: 'pending_payment', payment_method: 'bkash', placed_at: '2026-11-22T10:00:00Z', customer_name: 'Ayesha Rahman', customer_phone: '8801712345678',
  shipping_address: { division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-mirpur', thana: 'Mirpur', area: null, address_line: 'House 12', landmark: null, label: 'home' },
  lines: [], coupon_code: null, subtotal_amount: 120000, discount_amount: 0, shipping_amount: 7000, total_amount: 127000, due_amount: 127000, currency: 'BDT',
  delivery: { zone_name: 'Inside Dhaka', min_days: 1, max_days: 2 }, payment: null, paid_amount: 0, ...over,
});
const initiation = (over: Record<string, unknown> = {}) => ({ payment_id: PAY_ID, provider: 'bkash', status: 'redirect', redirect_url: GATEWAY_URL, amount: 127000, expires_at: '2026-11-22T10:30:00Z', ...over });
const payState = (over: Record<string, unknown> = {}) => ({ status: 'failed', provider: 'bkash', purpose: 'order', amount: 127000, expires_at: '2099-01-01T00:00:00Z', can_retry: true, can_switch_to_cod: true, ...over });
const result = (over: Record<string, unknown> = {}) => ({ status: 'succeeded', order_number: 'GS-1041', amount: 127000, currency: 'BDT', purpose: 'order', shop_name: 'Gallery Shop', ...over });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const sent = (i = 0) => ({ url: fetchMock.mock.calls[i]![0], init: fetchMock.mock.calls[i]![1], headers: fetchMock.mock.calls[i]![1].headers as Record<string, string> });
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  const values: Record<string, string> = {
    name: 'Ayesha Rahman', phone: '01712345678', email: '', district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: '', address_line: 'House 12, Road 7',
    landmark: '', label: 'home', customer_note: '', idempotency_key: KEY, expected_total_amount: '127000', ...over,
  };
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const idle = { status: 'idle' as const, message: null, fieldErrors: {}, idempotencyKey: KEY };
const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  jar.clear();
  storeState.mode = 'live';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Zod schemas for the 5b payment payloads', () => {
  it('PaymentInitiation: accepts a gateway redirect, strips unknown keys', () => {
    expect(schemas.parsePaymentInitiation({ ...initiation(), secret: 'x' })).toEqual(initiation());
  });

  it('PaymentInitiation: an unsafe redirect URL is never followed (→ initiation_failed)', () => {
    for (const bad of ['javascript:alert(1)', '//evil.test/x', 'https://user:pw@evil.test/', '/relative', 42]) {
      expect(schemas.parsePaymentInitiation(initiation({ redirect_url: bad }))).toMatchObject({ status: 'initiation_failed', redirect_url: null });
    }
    expect(schemas.safeGatewayUrl('http://localhost:8010/api/v1/dev/fake-gateway/x', false)).toBeNull();
    expect(schemas.safeGatewayUrl('http://localhost:8010/api/v1/dev/fake-gateway/x', true)).toBe('http://localhost:8010/api/v1/dev/fake-gateway/x');
    expect(schemas.parsePaymentInitiation(initiation({ payment_id: '../x' }))).toBeNull();
    expect(schemas.parsePaymentInitiation(initiation({ provider: 'paypal' }))).toBeNull();
  });

  it('CheckoutResult: payment null for COD; a broken initiation fails the payload', () => {
    const base = { order: order({ status: 'pending', payment_method: 'cod' }), confirmation_token: ORDER_TOKEN };
    expect(schemas.parseCheckoutResult({ ...base, payment: null })?.payment).toBeNull();
    expect(schemas.parseCheckoutResult(base)?.payment).toBeNull();
    expect(schemas.parseCheckoutResult({ ...base, payment: initiation() })?.payment?.redirect_url).toBe(GATEWAY_URL);
    expect(schemas.parseCheckoutResult({ ...base, payment: { status: 'redirect' } })).toBeNull();
  });

  it('StorefrontOrder.payment (StorefrontPaymentState) parses; junk → null', () => {
    expect(schemas.parseStorefrontOrder(order({ payment: payState() }))?.payment).toEqual(payState());
    expect(schemas.parseStorefrontOrder(order({ payment: { status: 'weird' } }))?.payment).toBeNull();
  });

  it('orders/pay result, payment result and payment link view', () => {
    expect(schemas.parseOrderPayResult({ order: order({ status: 'pending' }), payment: null })).toMatchObject({ payment: null });
    expect(schemas.parseOrderPayResult({ order: order(), payment: initiation() })?.payment?.payment_id).toBe(PAY_ID);
    expect(schemas.parsePaymentResult({ ...result(), customer_phone: '8801712345678' })).toEqual(result());
    expect(schemas.parsePaymentResult(result({ status: 'paid' }))).toBeNull();
    const link = { order_number: 'GS-1041', shop_name: 'Gallery Shop', amount: 13000, currency: 'BDT', provider: 'bkash', expires_at: '2026-11-22T12:00:00Z', status: 'active' };
    expect(schemas.parsePaymentLinkView(link)).toEqual(link);
    expect(schemas.parsePaymentLinkView({ ...link, status: 'paid' })).toBeNull();
    expect(schemas.parsePaymentLinkView({ ...link, amount: 0 })).toBeNull();
  });
});

describe('checkout payment helpers', () => {
  it('labels and method order (P5B-12); empty config falls back to COD', () => {
    expect(payments.METHOD_LABEL.bkash).toBe('bKash');
    expect(payments.METHOD_LABEL.sslcommerz).toBe('Card or mobile banking');
    expect(payments.checkoutMethods(['sslcommerz', 'cod', 'bkash'])).toEqual(['cod', 'bkash', 'sslcommerz']);
    expect(payments.checkoutMethods([])).toEqual(['cod']);
    expect(payments.checkoutMethods(null)).toEqual(['cod']);
  });

  it('advance delivery charge applies to COD with a charge only (P5B-13)', () => {
    expect(payments.advanceRequired('delivery_charge', 'cod', 7000)).toBe(true);
    expect(payments.advanceRequired('delivery_charge', 'cod', 0)).toBe(false);
    expect(payments.advanceRequired('delivery_charge', 'bkash', 7000)).toBe(false);
    expect(payments.advanceRequired('none', 'cod', 7000)).toBe(false);
  });
});

describe('placeOrder with online payments', () => {
  beforeEach(() => jar.set('sp_cart', { value: CART }));

  it('online method: sets sp_order, clears sp_cart, then redirect()s to the gateway', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { order: order(), confirmation_token: ORDER_TOKEN, payment: initiation() } }));
    const err = await caught(placeOrder(idle, form({ payment_method: 'bkash' })));
    expect(err).toBeInstanceOf(RedirectError);
    expect((err as RedirectError).url).toBe(GATEWAY_URL);
    expect(isNextRedirect(err)).toBe(true);
    expect(jar.get('sp_order')!.value).toBe(ORDER_TOKEN);
    expect(jar.has('sp_cart')).toBe(false);
    expect(JSON.parse(String(sent().init.body))).toMatchObject({ payment_method: 'bkash' });
    expect(JSON.parse(String(sent().init.body))).not.toHaveProperty('advance_gateway');
  });

  it('COD with the advance delivery charge sends advance_gateway and redirects', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { order: order({ payment_method: 'cod' }), confirmation_token: ORDER_TOKEN, payment: initiation({ amount: 7000, provider: 'sslcommerz' }) } }));
    const err = await caught(placeOrder(idle, form({ payment_method: 'cod', advance_gateway: 'sslcommerz' })));
    expect(err).toBeInstanceOf(RedirectError);
    expect(JSON.parse(String(sent().init.body))).toMatchObject({ payment_method: 'cod', advance_gateway: 'sslcommerz' });
  });

  it('initiation_failed: the order exists → thank-you (with Retry there)', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { order: order(), confirmation_token: ORDER_TOKEN, payment: initiation({ status: 'initiation_failed', redirect_url: null }) } }));
    const r = await placeOrder(idle, form({ payment_method: 'bkash' }));
    expect(r).toMatchObject({ status: 'redirect', redirect: '/checkout/thank-you' });
    expect(jar.get('sp_order')!.value).toBe(ORDER_TOKEN);
  });

  it('plain COD still lands on thank-you', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { order: order({ status: 'pending', payment_method: 'cod' }), confirmation_token: ORDER_TOKEN, payment: null } }));
    expect(await placeOrder(idle, form())).toMatchObject({ status: 'redirect', redirect: '/checkout/thank-you' });
    expect(JSON.parse(String(sent().init.body))).toMatchObject({ payment_method: 'cod' });
  });

  it('422 advance_required: explains and rotates the key', async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: 'advance_required', message: 'Advance required.' } }));
    const r = await placeOrder(idle, form({ payment_method: 'cod' }));
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/delivery charge in advance/);
    expect(r.idempotencyKey).not.toBe(KEY);
  });

  it('rejects an unknown payment method or advance gateway without calling the API', async () => {
    expect(await placeOrder(idle, form({ payment_method: 'paypal' }))).toMatchObject({ status: 'error' });
    expect(await placeOrder(idle, form({ payment_method: 'cod', advance_gateway: 'paypal' }))).toMatchObject({ status: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payOrder (retry / switch to COD, P5B-17)', () => {
  beforeEach(() => jar.set('sp_order', { value: ORDER_TOKEN }));

  it('retry: X-Order-Token + Idempotency-Key + shopper IP, then redirect to the gateway', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { order: order(), payment: initiation() } }));
    const err = await caught(payOrder({ method: 'bkash', idempotencyKey: KEY }));
    expect((err as RedirectError).url).toBe(GATEWAY_URL);
    expect(sent().url).toBe('http://api.test/api/v1/storefront/orders/pay');
    expect(sent().headers).toMatchObject({ 'X-Order-Token': ORDER_TOKEN, 'Idempotency-Key': KEY, 'X-Storefront-Client-Ip': '203.0.113.9' });
    expect(JSON.parse(String(sent().init.body))).toEqual({ payment_method: 'bkash' });
    expect(sent().init.cache).toBe('no-store');
  });

  it('switch to COD → thank-you', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { order: order({ status: 'pending', payment_method: 'cod' }), payment: null } }));
    expect(await payOrder({ method: 'cod', idempotencyKey: KEY })).toEqual({ ok: true, redirect: '/checkout/thank-you' });
  });

  it('409 payment_not_pending: message and a fresh key; network error keeps the key', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'payment_not_pending', message: 'x' } }));
    const a = await payOrder({ method: 'bkash', idempotencyKey: KEY });
    expect(a).toMatchObject({ ok: false });
    if (a.ok) throw new Error('expected failure');
    expect(a.message).toMatch(/can't be paid online/);
    expect(a.idempotencyKey).not.toBe(KEY);
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const b = await payOrder({ method: 'bkash', idempotencyKey: KEY });
    expect(b).toMatchObject({ ok: false, idempotencyKey: KEY });
  });

  it('initiation_failed again: stays on the page with a message', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { order: order(), payment: initiation({ status: 'initiation_failed', redirect_url: null }) } }));
    expect(await payOrder({ method: 'bkash', idempotencyKey: KEY })).toMatchObject({ ok: false, message: expect.stringMatching(/bKash isn't responding/) });
  });

  it('without sp_order or with bad input: no API call', async () => {
    expect(await payOrder({ method: 'paypal', idempotencyKey: KEY })).toMatchObject({ ok: false });
    jar.clear();
    expect(await payOrder({ method: 'bkash', idempotencyKey: KEY })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payment links (P5B-22/23)', () => {
  const TOKEN = 'Ab3dE5gH9jK2';
  const link = { order_number: 'GS-1041', shop_name: 'Gallery Shop', amount: 13000, currency: 'BDT', provider: 'bkash', expires_at: '2099-01-01T00:00:00Z', status: 'active' };
  const render = async (token: string) => renderToStaticMarkup((await PayPage({ params: Promise.resolve({ token }) })) as React.ReactElement);

  it('payLink: POST with Idempotency-Key + shopper IP, then redirect', async () => {
    fetchMock.mockResolvedValue(json(200, { data: initiation({ amount: 13000 }) }));
    const err = await caught(payLink({ token: TOKEN, idempotencyKey: KEY }));
    expect((err as RedirectError).url).toBe(GATEWAY_URL);
    expect(sent().url).toBe(`http://api.test/api/v1/storefront/payment-links/${TOKEN}/pay`);
    expect(sent().headers).toMatchObject({ 'Idempotency-Key': KEY, 'X-Storefront-Client-Ip': '203.0.113.9' });
  });

  it('payLink: 404 → invalid; malformed token never reaches the API', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
    expect(await payLink({ token: TOKEN, idempotencyKey: KEY })).toMatchObject({ ok: false, invalid: true });
    fetchMock.mockClear();
    expect(await payLink({ token: '../../x', idempotencyKey: KEY })).toMatchObject({ ok: false, invalid: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('/pay/[token] valid: shop, order, amount, expiry and the gateway button', async () => {
    fetchMock.mockResolvedValue(json(200, { data: link }));
    const html = await render(TOKEN);
    expect(html).toContain('Pay ৳ 130 to confirm order GS-1041');
    expect(html).toContain('Gallery Shop');
    expect(html).toContain('This link expires on');
    expect(html).toContain('data-sp-pay-link');
    expect(sent().url).toBe(`http://api.test/api/v1/storefront/payment-links/${TOKEN}`);
    expect(sent().headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
    expect(sent().init.cache).toBe('no-store');
  });

  it('/pay/[token] invalid: unknown, expired, paid and malformed render one identical page', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'not_found', message: 'Not found.' } }));
    const a = await render(TOKEN);
    fetchMock.mockResolvedValue(json(200, { data: { ...link, status: 'paid' } }));
    const b = await render(TOKEN);
    fetchMock.mockClear();
    const c = await render('bad');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a).toContain("This payment link isn&#x27;t valid any more");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe('/api/payment-status (GET only)', () => {
  it('exports GET only (S12)', () => {
    expect(Object.keys(statusRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['GET']);
  });

  it('returns only the status, private no-store, forwarding the shopper IP', async () => {
    const { NextRequest } = await import('next/server');
    fetchMock.mockResolvedValue(json(200, { data: result({ status: 'pending' }) }));
    const res = await statusRoute.GET(new NextRequest(`http://demo.localhost/api/payment-status?payment=${PAY_ID}`));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ data: { status: 'pending' } });
    expect(sent().url).toBe(`http://api.test/api/v1/storefront/payments/${PAY_ID}/result`);
    expect(sent().headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
  });

  it('rejects a malformed id without calling the API', async () => {
    const { NextRequest } = await import('next/server');
    const res = await statusRoute.GET(new NextRequest('http://demo.localhost/api/payment-status?payment=../../admin'));
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pending payment polling (2 s, stop at 30 s)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls every 2 s and stops at 30 s with onTimeout', async () => {
    const fetchStatus = vi.fn(async () => 'pending' as const);
    const onSettled = vi.fn();
    const onTimeout = vi.fn();
    payments.startPaymentPoller({ fetchStatus, onSettled, onTimeout });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchStatus).toHaveBeenCalledTimes(14);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(14);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('settles on a final status and keeps polling through transient errors', async () => {
    const fetchStatus = vi.fn<() => Promise<PolledStatus | null>>();
    fetchStatus.mockResolvedValueOnce('pending').mockResolvedValueOnce(null).mockResolvedValueOnce('succeeded');
    const onSettled = vi.fn();
    const onTimeout = vi.fn();
    payments.startPaymentPoller({ fetchStatus, onSettled, onTimeout });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onSettled).toHaveBeenCalledWith('succeeded');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('stop() on unmount ends polling', async () => {
    const fetchStatus = vi.fn(async () => 'pending' as const);
    const stop = payments.startPaymentPoller({ fetchStatus, onSettled: vi.fn(), onTimeout: vi.fn() });
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe('payment-result page states', () => {
  /** Routes the mocked API by path: payment result and order confirmation. */
  const api = (res: { result?: [number, unknown]; confirmation?: [number, unknown] }) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/payments/')) return json(...(res.result ?? [404, { error: { code: 'not_found', message: '' } }]));
      if (url.endsWith('/orders/confirmation')) return json(...(res.confirmation ?? [404, { error: { code: 'not_found', message: '' } }]));
      return json(404, { error: { code: 'not_found', message: '' } });
    });
  const render = async (payment: string = PAY_ID) =>
    renderToStaticMarkup((await PaymentResultPage({ searchParams: Promise.resolve({ payment }) })) as React.ReactElement);

  beforeEach(() => jar.set('sp_order', { value: ORDER_TOKEN }));

  it('succeeded: thank-you view with "Paid ৳ N with bKash"', async () => {
    api({ result: [200, { data: result() }], confirmation: [200, { data: order({ status: 'confirmed', payment: payState({ status: 'succeeded' }), paid_amount: 127000, due_amount: 0 }) }] });
    const html = await render();
    expect(html).toContain('data-sp-confirmation="placed"');
    expect(html).toContain('Paid ৳ 1,270 with bKash');
    expect(html).not.toContain('in cash when it arrives');
  });

  it('succeeded advance: "Pay ৳ due in cash when it arrives"', async () => {
    api({ result: [200, { data: result({ amount: 7000, purpose: 'advance' }) }], confirmation: [200, { data: order({ status: 'confirmed', payment_method: 'cod', payment: payState({ status: 'succeeded', amount: 7000, purpose: 'advance' }), paid_amount: 7000, due_amount: 120000 }) }] });
    const html = await render();
    expect(html).toContain('Paid ৳ 70 with bKash');
    expect(html).toContain('Pay ৳ 1,200 in cash when it arrives');
  });

  it('pending: polling view', async () => {
    api({ result: [200, { data: result({ status: 'pending' }) }], confirmation: [200, { data: order({ payment: payState({ status: 'pending' }) }) }] });
    const html = await render();
    expect(html).toContain('data-sp-confirmation="pending"');
    expect(html).toContain('data-sp-polling');
  });

  it('failed: "Payment didn\'t go through" with Retry and Pay on delivery', async () => {
    api({ result: [200, { data: result({ status: 'failed' }) }], confirmation: [200, { data: order({ payment: payState() }) }] });
    const html = await render();
    expect(html).toContain('Payment didn&#x27;t go through');
    expect(html).toContain('Try again with bKash');
    expect(html).toContain('Pay on delivery instead');
  });

  it('cancelled without COD allowed: Retry only', async () => {
    api({ result: [200, { data: result({ status: 'cancelled' }) }], confirmation: [200, { data: order({ payment: payState({ status: 'cancelled', can_switch_to_cod: false }) }) }] });
    const html = await render();
    expect(html).toContain('Try again with bKash');
    expect(html).not.toContain('Pay on delivery instead');
  });

  it('without sp_order (or another order) → minimal card, no PII', async () => {
    jar.clear();
    api({ result: [200, { data: result({ status: 'failed' }) }] });
    const html = await render();
    expect(html).toContain('data-sp-payment-page="result-failed"');
    expect(html).not.toContain('Ayesha');
    expect(html).not.toContain('Try again with');
  });

  it('unknown or malformed payment id', async () => {
    api({});
    expect(await render()).toContain('We couldn&#x27;t find this payment');
    fetchMock.mockClear();
    expect(await render('<script>')).toContain('We couldn&#x27;t find this payment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolvePaymentResult only shows the order when the cookie names the same order', async () => {
    api({ result: [200, { data: result({ order_number: 'GS-9999' }) }], confirmation: [200, { data: order() }] });
    const v = await resolvePaymentResult({ host: 'demo.localhost', previewToken: null, clientIp: null }, PAY_ID, ORDER_TOKEN);
    expect(v.kind).toBe('card');
  });
});

describe('thank-you shows the payment state', () => {
  beforeEach(() => jar.set('sp_order', { value: ORDER_TOKEN }));
  const render = async () => renderToStaticMarkup((await ThankYouPage()) as React.ReactElement);

  it('unpaid pending_payment → Retry / switch to COD', async () => {
    fetchMock.mockResolvedValue(json(200, { data: order({ payment: payState({ status: 'pending' }) }) }));
    const html = await render();
    expect(html).toContain('data-sp-confirmation="unpaid"');
    expect(html).toContain('Try again with bKash');
    expect(html).toContain('Pay on delivery instead');
    expect(sent().headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
  });

  it('plain COD order unchanged', async () => {
    fetchMock.mockResolvedValue(json(200, { data: order({ status: 'pending', payment_method: 'cod' }) }));
    const html = await render();
    expect(html).toContain('Thank you, Ayesha!');
    expect(html).toContain('Pay ৳ 1,270 in cash when it arrives');
  });
});

describe('robots and caching for /pay', () => {
  it('Disallow: /pay and /pay pages are private', async () => {
    const { robotsResponse } = await import('@/lib/seo-files');
    const { isPrivateCommercePath } = await import('@/proxy');
    const store = { host: 'demo.localhost', mode: 'live', config: { store: { primary_host: 'demo.localhost' }, seo: { noindex: false } } };
    expect(await robotsResponse(store as never).text()).toContain('Disallow: /pay\n');
    expect(['/pay/Ab3dE5gH9jK2', '/pay/result', '/checkout/payment-result'].every(isPrivateCommercePath)).toBe(true);
    expect(isPrivateCommercePath('/payments-info')).toBe(false);
  });
});

