import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PHASE-8-8 §7 / §10.4 fake-order guard at checkout: OTP request action, otp_* / cod_unavailable / order_limit_reached
// handling in placeOrder, the pure helpers the form uses, and the composed OTP field + privacy line.

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
vi.mock('@/lib/store', () => ({ findCurrentStore: async () => ({ host: 'demo.localhost', mode: 'live', config: { store: { status: 'active' } } }) }));
vi.mock('@/lib/preview', () => ({ getPreviewToken: async () => null }));

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const { placeOrder, requestCheckoutOtp } = await import('@/app/actions/commerce');
const { CheckoutForm, OtpField, otpMissing, otpVisible } = await import('@/themes/modern-commerce/commerce/checkout-form');
const { GUARD_COPY, attemptsLeft, cleanOtpInput, formatCountdown, parseCheckoutOtp } = await import('@/lib/checkout-guard');
const { parseApiError } = await import('@/lib/commerce-schemas');

const TOKEN = 'T'.repeat(43);
const KEY = '11111111-2222-3333-4444-555555555555';
const PHONE = '8801712345678';
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sentBody = (i = 0) => JSON.parse(String(fetchMock.mock.calls[i]![1].body)) as Record<string, unknown>;
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
const refuse = (code: string, details?: Record<string, unknown>) => json(422, { error: { code, message: 'x', ...(details ? { details } : {}) } });

beforeEach(() => {
  jar.clear();
  jar.set('sp_cart', TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('requestCheckoutOtp (server action)', () => {
  it('POSTs the normalized phone with the cart token and returns the answer', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { required: true, expires_at: '2026-11-24T10:05:00Z', resend_after_seconds: 60 } }));
    const r = await requestCheckoutOtp({ phone: '01712-345678' });
    expect(r).toEqual({ ok: true, phone: PHONE, required: true, resendAfterSeconds: 60, expiresAt: '2026-11-24T10:05:00Z' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/storefront/checkout/otp');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Cart-Token']).toBe(TOKEN);
    expect(sentBody()).toEqual({ phone: PHONE });
  });

  it('required: false (same answer for blocked, known and new numbers) passes through', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { required: false, expires_at: null, resend_after_seconds: 0 } }));
    expect(await requestCheckoutOtp({ phone: '01712345678' })).toMatchObject({ ok: true, required: false });
  });

  it('429 from the limiter → the too-many message', async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: 'rate_limited', message: 'Too many' } }));
    expect(await requestCheckoutOtp({ phone: '01712345678' })).toEqual({ ok: false, phone: PHONE, message: GUARD_COPY.otpTooMany.en });
  });

  it('a malformed payload is refused at the boundary', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { required: 'yes' } }));
    expect(await requestCheckoutOtp({ phone: '01712345678' })).toMatchObject({ ok: false });
  });

  it('invalid phone or no cart → no API call', async () => {
    expect(await requestCheckoutOtp({ phone: '12345' })).toMatchObject({ ok: false, phone: null });
    jar.clear();
    expect(await requestCheckoutOtp({ phone: '01712345678' })).toMatchObject({ ok: true, required: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('placeOrder with the guard', () => {
  it('sends otp_code for COD only, and only 6 digits', async () => {
    fetchMock.mockResolvedValue(refuse('otp_invalid', { attempts_left: 4 }));
    await placeOrder(idle, form({ otp_code: '123456' }));
    expect(sentBody(0).otp_code).toBe('123456');
    await placeOrder(idle, form({ otp_code: '12345' }));
    expect(sentBody(1)).not.toHaveProperty('otp_code');
    fetchMock.mockResolvedValue(refuse('payment_method_unavailable'));
    await placeOrder(idle, form({ otp_code: '123456', payment_method: 'bkash' }));
    expect(sentBody(2)).not.toHaveProperty('otp_code');
  });

  it('otp_required → code error under the field, no top message, key rotated', async () => {
    fetchMock.mockResolvedValue(refuse('otp_required'));
    const r = await placeOrder(idle, form());
    expect(r).toMatchObject({ status: 'error', message: null, otpError: 'Enter the code we sent.', guard: { code: 'otp_required', phone: PHONE, attemptsLeft: null } });
    expect(r.idempotencyKey).not.toBe(KEY);
  });

  it('otp_invalid → tries left from details (number on the wire)', async () => {
    fetchMock.mockResolvedValue(refuse('otp_invalid', { attempts_left: 3 }));
    const r = await placeOrder(idle, form({ otp_code: '000000' }));
    expect(r).toMatchObject({ status: 'error', message: null, otpError: "That code isn't right. 3 tries left.", guard: { code: 'otp_invalid', attemptsLeft: 3 } });
    fetchMock.mockResolvedValue(refuse('otp_invalid', { attempts_left: 0 }));
    expect((await placeOrder(idle, form({ otp_code: '000000' }))).otpError).toBe("That code isn't right. Send a new code.");
  });

  it('cod_unavailable → neutral message, guard for that phone', async () => {
    fetchMock.mockResolvedValue(refuse('cod_unavailable'));
    const r = await placeOrder(idle, form());
    expect(r).toMatchObject({ status: 'error', message: "Cash on delivery isn't available for this number. Please pay online.", guard: { code: 'cod_unavailable', phone: PHONE } });
    expect(r.idempotencyKey).not.toBe(KEY);
  });

  it('order_limit_reached → the P88-11 copy', async () => {
    fetchMock.mockResolvedValue(refuse('order_limit_reached'));
    expect(await placeOrder(idle, form())).toMatchObject({
      status: 'error',
      message: "You've reached today's order limit for cash on delivery. Please pay online or try tomorrow.",
      guard: { code: 'order_limit_reached' },
    });
  });

  it('429 from the limiter keeps the key and asks to wait', async () => {
    fetchMock.mockResolvedValue(new Response('Too Many Attempts.', { status: 429 }));
    const r = await placeOrder(idle, form());
    expect(r).toMatchObject({ status: 'error', message: 'Too many tries. Wait a minute and try again.' });
    expect(r.idempotencyKey).toBe(KEY);
  });

  it('other errors carry no guard', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'checkout_changed', message: 'Changed' } }));
    expect((await placeOrder(idle, form())).guard).toBeUndefined();
  });
});

describe('helpers', () => {
  it('formats the resend timer', () => {
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(0.2)).toBe('0:01');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(GUARD_COPY.resendIn(42)).toEqual({ en: 'Resend in 0:42', bn: '০:৪২ পরে আবার পাঠান' });
  });

  it('keeps 6 digits only (Bangla digits become ASCII)', () => {
    expect(cleanOtpInput('12 34-5678')).toBe('123456');
    expect(cleanOtpInput('১২৩৪৫৬')).toBe('123456');
    expect(cleanOtpInput('abc')).toBe('');
  });

  it('reads attempts_left from error details (scalar or list)', () => {
    expect(attemptsLeft(parseApiError({ error: { code: 'otp_invalid', message: '', details: { attempts_left: 2 } } }, 422).details)).toBe(2);
    expect(attemptsLeft({ attempts_left: ['4'] })).toBe(4);
    expect(attemptsLeft({})).toBeNull();
    expect(attemptsLeft({ attempts_left: ['many'] })).toBeNull();
  });

  it('validates the /otp payload', () => {
    expect(parseCheckoutOtp({ required: true, expires_at: null, resend_after_seconds: 60 })).toEqual({ required: true, expires_at: null, resend_after_seconds: 60 });
    expect(parseCheckoutOtp({ required: false })).toEqual({ required: false, expires_at: null, resend_after_seconds: 60 });
    expect(parseCheckoutOtp(null)).toBeNull();
  });

  it('shows the code field for COD once a code was sent or asked for', () => {
    const sent = { phone: PHONE, status: 'sent' as const, resendAt: 0 };
    expect(otpVisible('cod', PHONE, sent, null)).toBe(true);
    expect(otpVisible('bkash', PHONE, sent, null)).toBe(false);
    expect(otpVisible('cod', PHONE, { ...sent, status: 'not_needed' }, null)).toBe(false);
    expect(otpVisible('cod', PHONE, { ...sent, status: 'not_needed' }, PHONE)).toBe(true);
    expect(otpVisible('cod', '8801812345678', sent, null)).toBe(false);
    expect(otpVisible('cod', null, sent, null)).toBe(false);
  });

  it('asks for the code locally only when one is expected', () => {
    const sent = { phone: PHONE, status: 'sent' as const, resendAt: 0 };
    expect(otpMissing('', sent, PHONE, null)).toBe(true);
    expect(otpMissing('12345', sent, PHONE, null)).toBe(true);
    expect(otpMissing('123456', sent, PHONE, null)).toBe(false);
    expect(otpMissing('', { ...sent, status: 'error' }, PHONE, null)).toBe(false);
    expect(otpMissing('', null, PHONE, PHONE)).toBe(true);
  });

  it('has Bangla for every new string', () => {
    for (const c of [GUARD_COPY.otpLabel, GUARD_COPY.otpHelp('01712-345678'), GUARD_COPY.resend, GUARD_COPY.otpRequired, GUARD_COPY.otpInvalid(3), GUARD_COPY.codUnavailable, GUARD_COPY.orderLimitReached, GUARD_COPY.privacy, GUARD_COPY.otpTooMany]) {
      expect(c.en.length).toBeGreaterThan(0);
      expect(c.bn).toMatch(/[ঀ-৿]/);
    }
    expect(GUARD_COPY.otpInvalid(3).bn).toContain('৩');
  });
});

describe('rendering', () => {
  it('OTP field: label, help with the phone, six boxes, resend timer', () => {
    const html = renderToStaticMarkup(createElement(OtpField, { phone: PHONE, value: '12', onChange: () => undefined, error: null, status: 'sent', resendSeconds: 42, onResend: () => undefined }));
    expect(html).toContain('<label for="otp_code"');
    expect(html).toContain('Verification code');
    expect(html).toContain('We sent a 6-digit code to 01712-345678.');
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html.match(/h-\[52px\] w-11/g)).toHaveLength(6);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Resend in 0:42<\/button>/);
  });

  it('OTP field: error and resend ready', () => {
    const html = renderToStaticMarkup(
      createElement(OtpField, { phone: PHONE, value: '', onChange: () => undefined, error: "That code isn't right. 3 tries left.", status: 'sent', resendSeconds: 0, onResend: () => undefined }),
    );
    expect(html).toContain('That code isn&#x27;t right. 3 tries left.');
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/<button[^>]*>Resend code<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Resend code/);
  });

  it('checkout shows the privacy line under the COD note and no code field before a phone is entered', () => {
    const html = renderToStaticMarkup(
      createElement(CheckoutForm, {
        geo: null,
        summary: { currency: 'BDT', itemsCount: 1, subtotal: 100_000, discount: 0, estimatedTotal: 100_000, coupon: null, lines: [] },
        idempotencyKey: KEY,
        notLiveMessage: null,
        paymentMethods: ['cod', 'bkash'],
        codAdvance: 'none',
      }),
    );
    expect(html).toContain('To prevent fake orders, we check your phone number&#x27;s delivery record with this shop.');
    expect(html.indexOf('data-sp-guard-privacy')).toBeGreaterThan(html.indexOf('For some cash orders'));
    expect(html).not.toContain('id="otp_code"');
    expect(html).not.toContain('data-sp-cod-unavailable');
  });
});
