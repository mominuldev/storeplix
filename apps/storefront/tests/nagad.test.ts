import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PHASE-8-9D §9.6 (part B, SF): Nagad is a checkout method labelled "Nagad" with the theme's wallet icon and footer
// badge, offered only when `config.commerce.payment_methods` lists it (the API adds it when the gateway is connected
// and enabled). Rule 8: the storefront only follows the API's redirect; paid state comes from the server.

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
const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock, useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/store', () => ({ findCurrentStore: async () => ({ host: 'demo.localhost', mode: 'live', config: { store: { status: 'active' } } }) }));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => null }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { placeOrder } = await import('@/app/actions/commerce');
const { CheckoutForm } = await import('@/themes/modern-commerce/commerce/checkout-form');
const schemas = await import('@/lib/commerce-schemas');
const payments = await import('@/lib/payments');

const TOKEN = 'T'.repeat(43);
const KEY = '11111111-2222-3333-4444-555555555555';
const PAY_ID = '01JPAYMENT00000000000000AB';
const NAGAD_URL = 'https://sandbox.mynagad.com/check-out/MDYyODAwMDAwMDAwMDAwMDAwMDA';
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const form = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  const values: Record<string, string> = {
    name: 'Ayesha Rahman', phone: '01712345678', email: '', district_code: 'dhaka', thana_code: 'dhaka-mirpur', area: '', address_line: 'House 12, Road 7',
    landmark: '', label: 'home', customer_note: '', idempotency_key: KEY, expected_total_amount: '8000', ...over,
  };
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const idle = { status: 'idle' as const, message: null, fieldErrors: {}, idempotencyKey: KEY };
const summary = { currency: 'BDT', itemsCount: 1, subtotal: 100_000, discount: 0, estimatedTotal: 100_000, coupon: null, lines: [] };
const checkout = (paymentMethods: ('cod' | 'bkash' | 'sslcommerz' | 'nagad')[]) =>
  renderToStaticMarkup(createElement(CheckoutForm, { geo: null, summary, idempotencyKey: KEY, notLiveMessage: null, paymentMethods, codAdvance: 'none' }));

beforeEach(() => {
  jar.clear();
  jar.set('sp_cart', TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Nagad payment method (PHASE-8-9D §9.6)', () => {
  it('config: payment_methods keeps nagad; unknown methods are dropped', () => {
    const c = schemas.parseCommerce({ checkout_enabled: true, payment_methods: ['cod', 'nagad', 'paypal'], free_delivery_over_amount: null, delivery: [] });
    expect(c?.payment_methods).toEqual(['cod', 'nagad']);
  });

  it('checkout shows a "Nagad" card only when the store offers it', () => {
    const on = checkout(payments.checkoutMethods(['cod', 'nagad']));
    expect(on).toContain('data-sp-method="nagad"');
    expect(on).toContain('>Nagad<');
    expect(on).toContain('Pay now from your Nagad app');
    const off = checkout(payments.checkoutMethods(['cod', 'bkash']));
    expect(off).not.toContain('data-sp-method="nagad"');
    expect(off).not.toContain('Nagad');
  });

  it('a Nagad-only store preselects it and explains the Nagad page', () => {
    const html = checkout(['nagad']);
    expect(html).toMatch(/data-sp-method="nagad"><input type="radio"[^>]*checked=""/);
    expect(html).toContain('Nagad&#x27;s secure page');
  });

  it('copy helpers name Nagad in sentences', () => {
    expect(payments.paidWith('nagad')).toBe('with Nagad');
    expect(payments.paidWith('sslcommerz')).toBe('by card or mobile banking');
    expect(payments.gatewayPhrase('nagad')).toBe('Nagad');
    expect(payments.redirectTarget('nagad')).toBe('Nagad');
    expect(payments.redirectTarget('sslcommerz')).toBe('the payment page');
    expect(payments.isGateway('nagad')).toBe(true);
  });

  it('initiation: a Nagad redirect is accepted, an unsafe URL never followed', () => {
    const init = { payment_id: PAY_ID, provider: 'nagad', status: 'redirect', redirect_url: NAGAD_URL, amount: 127000, expires_at: '2026-11-22T10:30:00Z' };
    expect(schemas.parsePaymentInitiation(init)).toMatchObject({ provider: 'nagad', redirect_url: NAGAD_URL });
    expect(schemas.parsePaymentInitiation({ ...init, redirect_url: 'javascript:alert(1)' })).toMatchObject({ status: 'initiation_failed', redirect_url: null });
  });

  it('placeOrder sends payment_method nagad and follows only the API redirect', async () => {
    const order = {
      number: 'GS-1041', status: 'pending_payment', payment_method: 'nagad', placed_at: '2026-11-22T10:00:00Z', customer_name: 'Ayesha Rahman', customer_phone: '8801712345678',
      shipping_address: { division_code: 'dhaka', division: 'Dhaka', district_code: 'dhaka', district: 'Dhaka', thana_code: 'dhaka-mirpur', thana: 'Mirpur', area: null, address_line: 'House 12', landmark: null, label: 'home' },
      lines: [], coupon_code: null, subtotal_amount: 120000, discount_amount: 0, shipping_amount: 7000, total_amount: 127000, due_amount: 127000, currency: 'BDT',
      delivery: { zone_name: 'Inside Dhaka', min_days: 1, max_days: 2 }, payment: null, paid_amount: 0,
    };
    const payment = { payment_id: PAY_ID, provider: 'nagad', status: 'redirect', redirect_url: NAGAD_URL, amount: 127000, expires_at: '2026-11-22T10:30:00Z' };
    fetchMock.mockResolvedValue(json(201, { data: { order, confirmation_token: 'o'.repeat(43), payment } }));
    await placeOrder(idle, form({ payment_method: 'nagad' })).catch(() => undefined);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as Record<string, unknown>;
    expect(body.payment_method).toBe('nagad');
    expect(redirectMock).toHaveBeenCalledWith(NAGAD_URL);
  });
});
