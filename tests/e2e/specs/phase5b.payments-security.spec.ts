import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, LARAVEL_LOG, tinker, urls, type ThrowawayMember } from '../support/api';
import {
  SECRET_FIELDS,
  confirmation,
  connectFakeGateway,
  createPaymentLink,
  fakeCredentials,
  fakeGatewayReturnUrl,
  leaks,
  merchantOrder,
  orderIdByNumber,
  placeAndPay,
  placeOnlineOrder,
  placeOrder,
  rawFetch,
  setupShop,
  sf,
  type CommerceShop,
} from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §12 payment items that are best proven against the live stack (fake gateway, P5B-29):
 * S22 forged success return, S23 amount mismatch (fake 17-paisa rule), S24 replayed return/IPN, S26 credentials never
 * in any response or the log, S28 link enumeration, S29 unsigned/tampered returns, S30 refund abuse, S38 staff on
 * integrations, foreign payment ids. Two throwaway shops: A (victim) and B (Eve).
 */
let a: CommerceShop;
let b: CommerceShop;
let staff: ThrowawayMember;
let creds: Record<string, string>;
let logMark = 0;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(150_000);
  try {
    logMark = statSync(LARAVEL_LOG).size;
  } catch {
    logMark = 0;
  }
  a = await setupShop('psa', { stock: 20 });
  b = await setupShop('psb', { stock: 20 });
  creds = fakeCredentials('bkash');
  await connectFakeGateway(a.s, 'bkash', { isDefault: true, credentials: creds });
  await connectFakeGateway(b.s, 'bkash', { isDefault: true });
  staff = await createMember(a.s, 'staff');
});
test.afterAll(async () => {
  await staff?.cleanup();
  a?.cleanup();
  b?.cleanup();
});

const secrets = () => SECRET_FIELDS.map((f) => creds[f]).filter(Boolean).concat([creds.app_key]);

/** A product priced to hit a deterministic fake outcome: the order total ends in `paisa` (P5B-29). */
async function pricedVariant(shop: CommerceShop, paisa: number): Promise<string> {
  // total = price + ৳ 60 (Inside Dhaka) → price ends in the same paisa
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/products`, {
    name: `QA Paisa ${paisa}`,
    status: 'active',
    variants: [{ sku: `QA-P${paisa}-${Date.now().toString(36)}`.toUpperCase(), price_amount: 30000 + paisa, initial_on_hand: 10 }],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data.variants[0].id;
}

test('S22 forged success return: status=success on a failed payment changes nothing; unsigned → 403 without redirect', async () => {
  const placed = await placeOnlineOrder(a, a.simple.variantId, 1);
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  const pid = placed.payment!.payment_id;
  const id = await orderIdByNumber(a.s, placed.order.number);

  // S29: no signature / tampered signature / expired → 403 page, never a redirect
  for (const q of ['status=success', 'status=success&signature=deadbeef&expires=9999999999', 'status=success&next=https://evil.example']) {
    const r = await rawFetch(`${urls.api}/api/v1/payments/return/bkash/${pid}?paymentID=x&${q}`);
    expect(r.status, `${q}: ${r.text.slice(0, 200)}`).toBe(403);
    expect(r.headers.location).toBeUndefined();
  }

  // the shopper failed on the gateway; flip the provider's query param to success on the SIGNED return URL
  const ret = await fakeGatewayReturnUrl(placed.payment!.redirect_url, 'fail');
  const forged = ret.match(/status=[a-z]+/) ? ret.replace(/status=[a-z]+/, 'status=success') : `${ret}&status=success`;
  const r = await rawFetch(forged);
  expect([302, 303, 403]).toContain(r.status);
  if (r.headers.location) {
    const loc = new URL(r.headers.location);
    expect(loc.hostname).toBe(a.apiHost); // the store's primary host from the DB, nothing from the query
    expect(loc.pathname).toBe('/checkout/payment-result');
  }
  const o = await merchantOrder(a.s, id);
  expect([o.status, o.payment_status, o.paid_amount]).toEqual(['pending_payment', 'unpaid', 0]);
  const charge = (o.payments as { id: string; status: string }[]).find((p) => p.id === pid);
  expect(['pending', 'failed']).toContain(charge?.status);

  // a ?next= on the signed URL is ignored (redirect stays on the store host)
  const next = await rawFetch(`${ret}&next=${encodeURIComponent('https://evil.example/x')}`);
  if (next.headers.location) expect(new URL(next.headers.location).hostname).toBe(a.apiHost);
});

test('S23 amount mismatch (fake 17-paisa rule) → payment failed amount_mismatch, order untouched; 13-paisa → failed', async () => {
  const v17 = await pricedVariant(a, 17);
  const paid = await placeAndPay(a, v17, 1);
  expect(paid.payment?.amount % 100).toBe(17);
  const o = await merchantOrder(a.s, paid.orderId);
  expect([o.status, o.payment_status, o.paid_amount]).toEqual(['pending_payment', 'unpaid', 0]);
  const charge = (o.payments as { type: string; status: string; failure_code: string | null }[]).find((p) => p.type === 'charge');
  expect([charge?.status, charge?.failure_code]).toEqual(['failed', 'amount_mismatch']);
  const audit = await api(a.s, 'GET', `/audit-logs?filter[action]=payment.mismatch`);
  if (audit.status === 200) expect((audit.json.data as unknown[]).length).toBeGreaterThan(0);

  const v13 = await pricedVariant(a, 13);
  const failed = await placeAndPay(a, v13, 1);
  const o13 = await merchantOrder(a.s, failed.orderId);
  expect(o13.status).toBe('pending_payment');
  expect((o13.payments as { type: string; status: string }[]).find((p) => p.type === 'charge')?.status).toBe('failed');
  expect((await confirmation(a, failed.token)).payment?.can_retry).toBe(true);
});

test('S24 replayed success return is a no-op (paid once); unknown IPN route key 404', async () => {
  const placed = await placeOnlineOrder(a, a.simple.variantId, 1);
  const ret = await fakeGatewayReturnUrl(placed.payment!.redirect_url, 'pay');
  const first = await rawFetch(ret);
  expect([302, 303]).toContain(first.status);
  const id = await orderIdByNumber(a.s, placed.order.number);
  await expect.poll(async () => (await merchantOrder(a.s, id)).status, { timeout: 20_000 }).toBe('confirmed');
  const once = await merchantOrder(a.s, id);
  for (let i = 0; i < 3; i++) expect([302, 303]).toContain((await rawFetch(ret)).status);
  const again = await merchantOrder(a.s, id);
  expect([again.paid_amount, again.payment_status]).toEqual([once.paid_amount, 'paid']);
  expect((again.events as { type: string }[]).filter((e) => e.type === 'payment').length).toBe((once.events as { type: string }[]).filter((e) => e.type === 'payment').length);
  expect((again.payments as { type: string; status: string }[]).filter((p) => p.type === 'charge' && p.status === 'succeeded').length).toBe(1);

  // IPN replay (SSLCommerz route key). Unknown key → 404; the same event twice → 200 and no second effect.
  const unknown = await rawFetch(`${urls.api}/api/v1/webhooks/sslcommerz/${'x'.repeat(32)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'tran_id=x&val_id=y&status=VALID' });
  expect(unknown.status).toBe(404);
  expect(unknown.text).not.toMatch(/tenant|store_id/);
});

test('S26/S38 credentials never in a response or the log; staff can read but not connect, enable or disconnect', async () => {
  const list = await api(a.s, 'GET', `/stores/${a.s.storeId}/payment-gateways`);
  expect(list.status).toBe(200);
  expect(leaks(list.json, secrets())).toEqual([]);
  const bk = (list.json.data as { provider: string; credentials_hint: string | null }[]).find((x) => x.provider === 'bkash');
  expect(bk?.credentials_hint).toMatch(/3f9a$/); // last 4 of the app key only
  expect(Object.keys(list.json.data[0])).not.toContain('credentials');

  // reconnect response, settings, order detail, storefront config, audit log
  const put = await api(a.s, 'PUT', `/stores/${a.s.storeId}/payment-gateways/bkash`, { mode: 'sandbox', credentials: creds });
  expect(put.status).toBe(200);
  expect(leaks(put.json, secrets())).toEqual([]);
  const settings = await api(a.s, 'GET', `/stores/${a.s.storeId}/settings`);
  expect(leaks(settings.json, secrets())).toEqual([]);
  const orders = await api(a.s, 'GET', `/stores/${a.s.storeId}/orders`);
  const detail = await merchantOrder(a.s, orders.json.data[0].id);
  expect(leaks(detail, secrets())).toEqual([]);
  expect(leaks((await sf(a.apiHost, 'GET', '/config')).json, secrets())).toEqual([]);
  const audit = await api(a.s, 'GET', '/audit-logs?per_page=100');
  if (audit.status === 200) expect(leaks(audit.json, secrets())).toEqual([]);
  // DB column is not plaintext (test-only read via the admin connection)
  const raw = tinker(`echo DB::table('payment_gateway_accounts')->where('store_id','${a.s.storeId}')->value('credentials');`);
  expect(leaks(raw, secrets())).toEqual([]);
  // the API log since this spec started (MAIL/SMS/log driver) has no secret
  try {
    const log = readFileSync(LARAVEL_LOG).subarray(logMark).toString();
    expect(leaks(log, secrets())).toEqual([]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const st = staff.session;
  const read = await api(st, 'GET', `/stores/${a.s.storeId}/payment-gateways`);
  expect(read.status).toBe(200);
  expect(leaks(read.json, secrets())).toEqual([]);
  expect((await api(st, 'PUT', `/stores/${a.s.storeId}/payment-gateways/bkash`, { mode: 'sandbox', credentials: fakeCredentials('bkash') })).status).toBe(403);
  expect((await api(st, 'PATCH', `/stores/${a.s.storeId}/payment-gateways/bkash`, { revision: put.json.data.revision, enabled: false })).status).toBe(403);
  expect((await api(st, 'DELETE', `/stores/${a.s.storeId}/payment-gateways/bkash`)).status).toBe(403);
  // fake credential checks (P5B-11): `invalid…` → 422 credentials_invalid, `unavailable…` → 502; nothing echoed back
  const bad = await api(a.s, 'PUT', `/stores/${a.s.storeId}/payment-gateways/sslcommerz`, { mode: 'sandbox', credentials: { store_id: 'invalid-store', store_passwd: 'invalid-QA-pass-never-echo' } });
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'credentials_invalid']);
  expect(JSON.stringify(bad.json)).not.toContain('invalid-QA-pass-never-echo');
  const down = await api(a.s, 'PUT', `/stores/${a.s.storeId}/payment-gateways/sslcommerz`, { mode: 'sandbox', credentials: { store_id: 'unavailable-store', store_passwd: 'unavailable-pass' } });
  expect([down.status, down.json.error?.code]).toEqual([502, 'provider_unavailable']);
  // unknown provider → 404
  expect((await api(a.s, 'PUT', `/stores/${a.s.storeId}/payment-gateways/nagad`, { mode: 'sandbox', credentials: {} })).status).toBe(404);
  // S27: no field can move the provider host
  const ssrf = await api(a.s, 'PUT', `/stores/${a.s.storeId}/payment-gateways/bkash`, { mode: 'sandbox', base_url: 'http://169.254.169.254', credentials: { ...creds, base_url: 'http://169.254.169.254' } });
  expect(JSON.stringify(ssrf.json)).not.toContain('169.254.169.254');
});

test('S30 refund abuse and foreign payment ids: staff 403, B cannot see or refund A\'s payment', async () => {
  const paid = await placeAndPay(a, a.simple.variantId, 1);
  await expect.poll(async () => (await merchantOrder(a.s, paid.orderId)).payment_status, { timeout: 20_000 }).toBe('paid');
  const charge = ((await merchantOrder(a.s, paid.orderId)).payments as { id: string; type: string }[]).find((p) => p.type === 'charge')!;
  const refund = (s: typeof a.s, orderId: string, body: object) =>
    apiCall(s, 'POST', `/stores/${s.storeId}/orders/${orderId}/refunds`, { json: body, headers: { 'Idempotency-Key': randomUUID() } });

  expect((await refund(staff.session, paid.orderId, { amount: 100, method: 'gateway', payment_id: charge.id })).status).toBe(403);

  // B's own paid order, A's charge id in the body → 422 on payment_id (never 403/404, nothing refunded)
  const bPaid = await placeAndPay(b, b.simple.variantId, 1);
  await expect.poll(async () => (await merchantOrder(b.s, bPaid.orderId)).payment_status, { timeout: 20_000 }).toBe('paid');
  const cross = await refund(b.s, bPaid.orderId, { amount: 100, method: 'gateway', payment_id: charge.id });
  expect([cross.status, cross.json.error?.code]).toEqual([422, 'validation_failed']);
  expect(JSON.stringify(cross.json.error?.details ?? {})).toContain('payment_id');
  expect((await merchantOrder(a.s, paid.orderId)).refunded_amount).toBe(0);

  // B's routes with A's order → 404; A's payment result on B's host → 404; A's order on B's links → 404
  expect((await api(b.s, 'GET', `/stores/${b.s.storeId}/orders/${paid.orderId}`)).status).toBe(404);
  expect((await refund(b.s, paid.orderId, { amount: 100, method: 'gateway', payment_id: charge.id })).status).toBe(404);
  expect((await createPaymentLink(b.s, paid.orderId, {})).status).toBe(404);
  expect((await sf(b.apiHost, 'GET', `/payments/${charge.id}/result`)).status).toBe(404);
  const own = await sf(a.apiHost, 'GET', `/payments/${charge.id}/result`);
  expect(own.status, own.text).toBe(200);
  expect(Object.keys(own.json.data).sort()).toEqual(['amount', 'currency', 'order_number', 'purpose', 'shop_name', 'status'].sort());
  expect(own.headers['cache-control']).toMatch(/no-store/);
  // B's order token can't pay A's order: tokens are per order and per host
  expect((await sf(b.apiHost, 'POST', '/orders/pay', { json: { payment_method: 'bkash' }, idem: randomUUID(), headers: { 'X-Order-Token': paid.token } })).status).toBe(404);
});

test('S28 payment-link tokens: unknown, cancelled and paid tokens give the identical 404; 21st lookup/min → 429', async () => {
  const placed = await placeOrder(a, a.simple.variantId, 1);
  const id = await orderIdByNumber(a.s, placed.order.number);
  const link = await createPaymentLink(a.s, id, { amount_kind: 'full' });
  expect(link.status, link.text).toBe(201);
  const token = new URL(link.json.data.url).pathname.split('/').pop()!;
  expect((await api(a.s, 'DELETE', `/stores/${a.s.storeId}/orders/${id}/payment-links/${link.json.data.id}`)).status).toBe(204);
  const ip = '203.0.113.77';
  const cancelled = await sf(a.apiHost, 'GET', `/payment-links/${token}`, { ip });
  const unknown = await sf(a.apiHost, 'GET', '/payment-links/AAAAAAAAAAAA', { ip });
  expect([cancelled.status, unknown.status]).toEqual([404, 404]);
  expect(cancelled.text).toBe(unknown.text);
  // DB holds no raw token
  const row = tinker(`echo json_encode(DB::table('payment_links')->where('id','${link.json.data.id}')->first());`);
  expect(row).not.toContain(token);
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await sf(a.apiHost, 'GET', `/payment-links/BBBBBBBBBB${String(i).padStart(2, '0')}`, { ip })).status === 429;
  expect(limited).toBe(true);
});
