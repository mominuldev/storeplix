import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.STOREFRONT_API_KEY = 'test-key';
process.env.STOREFRONT_API_URL = 'http://api.test';

const start = await import('@/app/api/chat/start/route');
const session = await import('@/app/api/chat/session/route');
const verify = await import('@/app/api/chat/verify/route');
const messages = await import('@/app/api/chat/messages/route');
const chatAttachment = await import('@/app/api/chat/attachments/[id]/route');
const orderMessages = await import('@/app/api/order-messages/route');
const magic = await import('@/app/m/[code]/route');

const HOST = 'demo.localhost';
const TOKEN = 'S'.repeat(43);
const ORDER_TOKEN = 'o'.repeat(40);
const ACCESS = 'acc.'.repeat(8);
const ULID = '01JD0000000000000000000001';
const CLIENT_ID = '11111111-2222-4333-8444-555555555555';

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sent = (i = 0) => ({ url: fetchMock.mock.calls[i]![0], init: fetchMock.mock.calls[i]![1], headers: fetchMock.mock.calls[i]![1].headers as Record<string, string> });

function req(path: string, init: { method?: string; body?: BodyInit; cookies?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-storeplix-host': HOST, ...init.headers });
  if (init.cookies) headers.set('cookie', Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join('; '));
  return new NextRequest(`http://${HOST}${path}`, { method: init.method ?? 'GET', body: init.body, headers });
}
const setCookies = (res: Response) => res.headers.getSetCookie();
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const startForm = (over: Record<string, string | Blob> = {}) => {
  const fd = new FormData();
  const v: Record<string, string | Blob> = { name: 'Ayesha Rahman', phone: '01712-345678', message: 'Is this available?', client_id: CLIENT_ID, website: '', page_path: '/products/cardigan?utm=1', product_slug: 'cardigan', ...over };
  for (const [k, x] of Object.entries(v)) fd.append(k, x);
  return fd;
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/chat/start', () => {
  it('forwards server-to-server and keeps the session token in an httpOnly cookie only', async () => {
    fetchMock.mockResolvedValue(json(201, { data: { session_token: TOKEN, status: 'code_sent', phone_masked: '017••••5678', resend_after: 60 } }));
    const res = await start.POST(req('/api/chat/start', { method: 'POST', body: startForm() }));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).data).toEqual({ status: 'code_sent', phone_masked: '017••••5678', resend_after: 60 });
    const cookies = setCookies(res);
    expect(cookies.find((c) => c.startsWith('sp_chat='))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith('sp_chat='))).toMatch(/SameSite=lax/i);
    expect(cookies.find((c) => c.startsWith('sp_chat_on=1'))).not.toMatch(/HttpOnly/i);

    const call = sent();
    expect(call.url).toBe('http://api.test/api/v1/storefront/inbox/sessions');
    expect(call.headers).toMatchObject({ 'X-Storefront-Host': HOST, 'X-Storefront-Key': 'test-key' });
    const body = call.init.body as FormData;
    expect(body.get('phone')).toBe('8801712345678');
    expect(body.get('page_path')).toBe('/products/cardigan');
    expect(body.get('website')).toBe('');
  });

  it('refuses a cross-site post', async () => {
    const res = await start.POST(req('/api/chat/start', { method: 'POST', body: startForm(), headers: { origin: 'https://evil.example' } }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates fields before calling the API', async () => {
    const res = await start.POST(req('/api/chat/start', { method: 'POST', body: startForm({ phone: '12345', name: '' }) }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Object.keys(body.error.details)).toEqual(expect.arrayContaining(['name', 'phone']));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sniffs the attachment: an HTML file named .png is refused', async () => {
    const fake = new File(['<html><script>x</script>'], 'photo.png', { type: 'image/png' });
    const res = await start.POST(req('/api/chat/start', { method: 'POST', body: startForm({ file: fake }) }));
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes rate limits through with retry_after', async () => {
    fetchMock.mockResolvedValue(json(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'Retry-After': '42' }));
    const res = await start.POST(req('/api/chat/start', { method: 'POST', body: startForm() }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toEqual({ code: 'rate_limited', message: '', details: { retry_after: 42 } });
  });
});

describe('chat session, verify and messages', () => {
  it('no cookie → 404 without calling the API', async () => {
    const res = await session.GET(req('/api/chat/session'));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an expired session clears both cookies', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'inbox_session_invalid', message: '' } }));
    const res = await session.GET(req('/api/chat/session', { cookies: { sp_chat: TOKEN, sp_chat_on: '1' } }));
    expect(res.status).toBe(404);
    expect(sent().headers['X-Inbox-Session']).toBe(TOKEN);
    expect(setCookies(res).filter((c) => /Max-Age=0/i.test(c))).toHaveLength(2);
  });

  it('verify forwards attempts_left and never the API message', async () => {
    fetchMock.mockResolvedValue(json(422, { error: { code: 'inbox_code_invalid', message: 'secret detail', details: { attempts_left: 3 } } }));
    const res = await verify.POST(req('/api/chat/verify', { method: 'POST', body: JSON.stringify({ code: '123456' }), cookies: { sp_chat: TOKEN } }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 'inbox_code_invalid', message: '', details: { attempts_left: 3 } } });
  });

  it('messages poll passes the ETag and answers 304', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 304, headers: { ETag: 'W/"ix1.2.abc"' } }));
    const res = await messages.GET(req(`/api/chat/messages?after=${ULID}`, { cookies: { sp_chat: TOKEN }, headers: { 'if-none-match': 'W/"ix1.2.abc"' } }));
    expect(res.status).toBe(304);
    expect(sent().url).toBe(`http://api.test/api/v1/storefront/inbox/messages?after=${ULID}`);
    expect(sent().headers['If-None-Match']).toBe('W/"ix1.2.abc"');
  });

  it('messages are validated: only customer/shop rows reach the browser', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        data: [
          { id: ULID, from: 'shop', body: 'Hello', attachments: [], author_name: 'Demo', seen: false, created_at: '2026-11-28T10:00:00Z' },
          { id: '01JD0000000000000000000002', from: 'note', body: 'staff only', attachments: [], author_name: 'x', seen: false, created_at: '2026-11-28T10:00:00Z' },
        ],
      }, { ETag: 'W/"e1"' }),
    );
    const res = await messages.GET(req('/api/chat/messages', { cookies: { sp_chat: TOKEN } }));
    expect(res.headers.get('ETag')).toBe('W/"e1"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('staff only');
  });

  it('send requires a body or a file and a client_id', async () => {
    const fd = new FormData();
    fd.append('body', '   ');
    fd.append('client_id', CLIENT_ID);
    const res = await messages.POST(req('/api/chat/messages', { method: 'POST', body: fd, cookies: { sp_chat: TOKEN } }));
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('attachment proxy', () => {
  it('forces nosniff, a sandbox CSP and PDF as a download', async () => {
    fetchMock.mockResolvedValue(new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="invoice.pdf"' } }));
    const res = await chatAttachment.GET(req(`/api/chat/attachments/${ULID}`, { cookies: { sp_chat: TOKEN } }), params({ id: ULID }));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="invoice.pdf"');
  });
  it('refuses unexpected types from upstream', async () => {
    fetchMock.mockResolvedValue(new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }));
    const res = await chatAttachment.GET(req(`/api/chat/attachments/${ULID}`, { cookies: { sp_chat: TOKEN } }), params({ id: ULID }));
    expect(res.status).toBe(502);
  });
  it('needs a session', async () => {
    const res = await chatAttachment.GET(req(`/api/chat/attachments/${ULID}`), params({ id: ULID }));
    expect(res.status).toBe(404);
  });
});

describe('order messages access', () => {
  it('a cookie for another order is never used', async () => {
    const res = await orderMessages.GET(req('/api/order-messages?number=BG-2&via=track', { cookies: { sp_order_access: `BG-1~${ACCESS}` } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('order_access_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the held token for its own order', async () => {
    fetchMock.mockResolvedValue(json(200, { data: [] }));
    const res = await orderMessages.GET(req('/api/order-messages?number=BG-1&via=track', { cookies: { sp_order_access: `BG-1~${ACCESS}` } }));
    expect(res.status).toBe(200);
    expect(sent().headers['X-Order-Access']).toBe(ACCESS);
  });

  it('thank-you page: mints the token from the confirmation and sets it httpOnly', async () => {
    const order = {
      number: 'BG-7', status: 'pending', payment_method: 'cod', placed_at: '2026-11-28T10:00:00Z', customer_name: 'A', customer_phone: '8801712345678',
      shipping_address: { district_code: 'dhaka', thana_code: 'x', district: 'Dhaka', thana: 'X', area: null, address_line: 'H', landmark: null, label: null },
      lines: [], coupon_code: null, subtotal_amount: 1, discount_amount: 0, shipping_amount: 0, total_amount: 1, due_amount: 1, currency: 'BDT',
      delivery: { zone_name: 'Dhaka', min_days: 1, max_days: 2 }, payment: null, paid_amount: 0,
      messages: { enabled: true, access_token: ACCESS, unread_count: 0, reply_time: 'hour' },
    };
    fetchMock.mockResolvedValueOnce(json(200, { data: order })).mockResolvedValueOnce(json(200, { data: [] }));
    const res = await orderMessages.GET(req('/api/order-messages?number=BG-7&via=confirmation', { cookies: { sp_order: ORDER_TOKEN } }));
    expect(res.status).toBe(200);
    expect(sent(0).headers['X-Order-Token']).toBe(ORDER_TOKEN);
    expect(sent(1).headers['X-Order-Access']).toBe(ACCESS);
    const cookie = setCookies(res).find((c) => c.startsWith('sp_order_access='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(await res.text()).not.toContain(ACCESS);
  });
});

describe('/m/{code} magic link', () => {
  it('chat → sp_chat and /?chat=open', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { kind: 'chat', session_token: TOKEN } }));
    const res = await magic.GET(req('/m/AbCdEfGhIjKlMnOpQrStUv'), params({ code: 'AbCdEfGhIjKlMnOpQrStUv' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?chat=open');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(setCookies(res).find((c) => c.startsWith('sp_chat='))).toMatch(/HttpOnly/i);
    expect(sent().url).toBe('http://api.test/api/v1/storefront/inbox/links/AbCdEfGhIjKlMnOpQrStUv');
    expect(sent().init.method).toBe('POST');
  });
  it('order → sp_order_access and /track?view=messages', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { kind: 'order', access_token: ACCESS, number: 'BG-9' } }));
    const res = await magic.GET(req('/m/AbCdEfGhIjKlMnOpQrStUv'), params({ code: 'AbCdEfGhIjKlMnOpQrStUv' }));
    expect(res.headers.get('Location')).toBe('/track?view=messages');
    const cookie = setCookies(res).find((c) => c.startsWith('sp_order_access='));
    expect(decodeURIComponent(cookie!.split(';')[0]!)).toBe(`sp_order_access=BG-9~${ACCESS}`);
    expect(cookie).toMatch(/HttpOnly/i);
  });
  it('invalid → / with no cookie; HEAD never redeems', async () => {
    fetchMock.mockResolvedValue(json(404, { error: { code: 'inbox_link_invalid', message: '' } }));
    const res = await magic.GET(req('/m/AbCdEfGhIjKlMnOpQrStUv'), params({ code: 'AbCdEfGhIjKlMnOpQrStUv' }));
    expect(res.headers.get('Location')).toBe('/');
    expect(setCookies(res)).toHaveLength(0);
    const bad = await magic.GET(req('/m/x'), params({ code: '<x>' }));
    expect(bad.headers.get('Location')).toBe('/');
    expect(magic.HEAD().status).toBe(204);
  });
});
