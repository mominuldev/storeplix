import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, LARAVEL_LOG, mailMark, tinker, urls, type ThrowawayMember } from '../support/api';
import {
  GEO,
  cartAdd,
  checkout,
  checkoutBody,
  expectedTotal,
  forbiddenKeys,
  placeOrder,
  randomIp,
  randomPhone,
  setupShop,
  sf,
  transition,
  type CommerceShop,
} from '../support/commerce';
import { readFileSync, statSync } from 'node:fs';

/**
 * PHASE-5-CONTRACT §10 adversarial checks on the live stack (QA review A-checks). Two throwaway tenants:
 * `shop` (published) and `eve` (draft, own catalog), plus a staff member of `shop`. Never the demo store.
 */
let shop: CommerceShop;
let eve: CommerceShop;
let staff: ThrowawayMember;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('sec', { stock: 40 });
  eve = await setupShop('eve', { publish: false });
  staff = await createMember(shop.s, 'staff');
});

test.afterAll(async () => {
  await staff?.cleanup();
  shop?.cleanup();
  eve?.cleanup();
});

const logTail = (mark: number) => {
  const buf = readFileSync(LARAVEL_LOG);
  return buf.subarray(Math.min(mark, buf.length)).toString('utf8');
};

test('S4 idempotent checkout: replay = same order, other body = 409, missing/malformed key = 400', async () => {
  const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  const body = checkoutBody(0);
  body.expected_total_amount = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  const key = randomUUID();
  const first = await checkout(shop.apiHost, cart, body, key);
  expect(first.status, first.text).toBe(201);
  const replay = await checkout(shop.apiHost, cart, body, key);
  expect(replay.status).toBe(201);
  expect(replay.headers['idempotent-replayed']).toBe('true');
  expect(replay.json.data.order.number).toBe(first.json.data.order.number);
  const other = await checkout(shop.apiHost, cart, { ...body, customer_note: 'changed' }, key);
  expect([other.status, other.json.error?.code]).toEqual([409, 'idempotency_key_mismatch']);
  const missing = await checkout(shop.apiHost, cart, body, null);
  expect([missing.status, missing.json.error?.code]).toEqual([400, 'idempotency_key_required']);
  const malformed = await checkout(shop.apiHost, cart, body, 'not a key!');
  expect(malformed.status, malformed.text).toBe(400);
  const orders = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${first.json.data.order.number}`);
  expect(orders.json.data).toHaveLength(1);
});

test('S1/S11 tampered prices and mass assignment are ignored; tampered expected total writes nothing', async () => {
  const { cart } = await cartAdd(shop.apiHost, shop.variable.variants[0].id, 1);
  const before = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`)).json.meta.total;
  const body = checkoutBody(0, {
    unit_price_amount: 1, discount_amount: 99_999, total_amount: 1, shipping_amount: 0, status: 'delivered', payment_status: 'paid',
    number: 'HACK-1', customer_id: eve.s.storeId, store_id: eve.s.storeId, tenant_id: eve.s.tenantId, channel: 'whatsapp', paid_amount: 1,
    lines: [{ variant_id: shop.variable.variants[0].id, unit_price_amount: 1 }],
  });
  const tampered = await checkout(shop.apiHost, cart, { ...body, expected_total_amount: 1 });
  expect([tampered.status, tampered.json.error?.code]).toEqual([409, 'checkout_changed']);
  expect(tampered.json.error.details.expected_total_amount[0]).toMatch(/The total changed to ৳/);
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders`)).json.meta.total).toBe(before);
  body.expected_total_amount = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  const ok = await checkout(shop.apiHost, cart, body);
  expect(ok.status, ok.text).toBe(201);
  const o = ok.json.data.order;
  expect([o.status, o.subtotal_amount, o.discount_amount, o.shipping_amount, o.total_amount]).toEqual(['pending', 120000, 0, 6000, 126000]);
  expect(o.number).toMatch(/^[A-Z]{1,6}-\d{4,}$/);
  const detail = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${o.number}`);
  const row = detail.json.data[0];
  expect([row.channel, row.created_via, row.payment_status, row.paid_amount]).toEqual(['website', 'storefront', 'unpaid', 0]);
});

test('S5 cart bound to its store: shop cart token on Eve host → 404; DB holds sha256 only; token/phone never logged', async () => {
  const mark = mailMark();
  const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
  expect(cart).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Eve is a draft store: use a preview token so the host resolves, then the cart must still not be found.
  const preview = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/preview-token`, {});
  const crossed = await sf(eve.apiHost, 'GET', '/cart', { cart, preview: preview.json.data.token });
  expect([crossed.status, crossed.json.error?.code]).toEqual([404, 'cart_not_found']);
  const crossedAdd = await sf(eve.apiHost, 'POST', '/cart/items', { cart, preview: preview.json.data.token, json: { variant_id: eve.simple.variantId, quantity: 1 } });
  expect(crossedAdd.status).toBe(201); // a new Eve cart, never the shop's
  expect(crossedAdd.json.meta.cart_token).not.toBe(cart);
  const raw = tinker(`echo DB::table('carts')->where('token_hash','${cart}')->count().'|'.DB::table('carts')->where('token_hash',hash('sha256','${cart}'))->count();`).trim();
  expect(raw.split('\n').pop()).toBe('0|1');
  const phone = randomPhone();
  const body = checkoutBody(0, { contact: { phone } });
  body.expected_total_amount = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  expect((await checkout(shop.apiHost, cart, body)).status).toBe(201);
  const tail = logTail(mark);
  expect(tail).not.toContain(cart);
  expect(tail).not.toContain(phone.slice(1));
  expect(tail).not.toContain('House 12, Road 7A');
});

test('S6 foreign ids: Eve variant on shop host 422, shop ids on Eve routes 404, in Eve payloads 422', async () => {
  const add = await sf(shop.apiHost, 'POST', '/cart/items', { json: { variant_id: eve.simple.variantId, quantity: 1 } });
  expect(add.status).toBe(422);
  expect(add.json.error.details.variant_id[0]).toBe("This item isn't available.");
  const { order } = await placeOrder(shop, shop.simple.variantId);
  const orderId = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${order.number}`)).json.data[0].id as string;
  const coupon = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/coupons`, { code: `SEC${Date.now() % 100000}`, type: 'fixed', amount: 1000, status: 'active' });
  expect(coupon.status, JSON.stringify(coupon.json)).toBe(201);
  const zones = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/shipping`)).json.data.zones as Array<{ id: string }>;
  const pickup = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/pickup-locations`, { name: 'Main', district_code: 'dhaka', thana_code: 'dhaka-dhanmondi', address_line: 'House 1, Road 2' });
  expect(pickup.status, JSON.stringify(pickup.json)).toBe(201);
  const routes: Array<[string, string, unknown?]> = [
    ['GET', `/orders/${orderId}`], ['PATCH', `/orders/${orderId}`, { revision: 1, customer_note: 'x' }], ['POST', `/orders/${orderId}/confirm`, {}],
    ['POST', `/orders/${orderId}/cancel`, { reason: 'other' }], ['POST', `/orders/${orderId}/notes`, { body: 'x' }],
    ['POST', `/orders/${orderId}/refunds`, { amount: 100, method: 'cash' }], ['GET', `/coupons/${coupon.json.data.id}`],
    ['PATCH', `/coupons/${coupon.json.data.id}`, { revision: 1, status: 'disabled' }], ['DELETE', `/coupons/${coupon.json.data.id}`],
    ['PATCH', `/pickup-locations/${pickup.json.data.id}`, { name: 'x' }], ['DELETE', `/pickup-locations/${pickup.json.data.id}`],
  ];
  for (const storeId of [eve.s.storeId, shop.s.storeId]) {
    for (const [m, p, b] of routes) {
      const r = await api(eve.s, m, `/stores/${storeId}${p}`, b);
      // Eve's own store + shop ids → 404; shop's store id under Eve's tenant → 404 (never 403 for a foreign id)
      expect(r.status, `${m} ${storeId === eve.s.storeId ? 'eve' : 'shop'}${p} ${JSON.stringify(r.json)}`).toBe(404);
    }
  }
  const spoof = await api({ ...eve.s, tenantId: shop.s.tenantId }, 'GET', `/stores/${shop.s.storeId}/orders`);
  expect([spoof.status, spoof.json.error?.code]).toEqual([403, 'tenant_forbidden']);
  // shop ids inside Eve payloads
  const manualBody = { items: [{ variant_id: shop.simple.variantId, quantity: 1 }], channel: 'phone', contact: { name: 'X Y', phone: randomPhone() }, shipping_address: { ...GEO.dhanmondi, address_line: 'House 1, Road 2' }, notify_customer: false };
  // QA F-L: the quote answers 200 with an empty `unavailable` line (no name, price or stock of the foreign variant)
  const quote = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/orders/quote`, manualBody);
  expect([200, 422]).toContain(quote.status);
  if (quote.status === 200) expect([quote.json.data.lines[0].issue, quote.json.data.lines[0].product_name, quote.json.data.lines[0].unit_price_amount]).toEqual(['unavailable', '', 0]);
  const manual = await apiCall(eve.s, 'POST', `/stores/${eve.s.storeId}/orders`, { json: manualBody, headers: { 'Idempotency-Key': randomUUID() } });
  expect(manual.status, manual.text).toBe(422);
  expect(Object.keys(manual.json.error.details)).toContain('items.0.variant_id');
  const cpn = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/coupons`, { code: 'EVEX1', type: 'fixed', amount: 100, applies_to: 'products', product_ids: [shop.simple.id] });
  expect(cpn.status).toBe(422);
  expect(Object.keys(cpn.json.error.details)).toContain('product_ids.0');
  const cpc = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/coupons`, { code: 'EVEX2', type: 'fixed', amount: 100, applies_to: 'categories', category_ids: [shop.category.id] });
  expect(Object.keys(cpc.json.error?.details ?? {})).toContain('category_ids.0');
  const ship = await api(eve.s, 'PUT', `/stores/${eve.s.storeId}/shipping`, { free_delivery_over_amount: null, zones: [{ id: zones[0].id, name: 'Stolen', kind: 'custom', charge_amount: 0, min_days: 1, max_days: 2, areas: [] }, { name: 'Else', kind: 'fallback', charge_amount: 100, min_days: 1, max_days: 2 }] });
  expect([400, 404, 422]).toContain(ship.status);
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/shipping`)).json.data.zones[0].name).toBe('Inside Dhaka');
  const bulk = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/orders/bulk`, { action: 'confirm', ids: [orderId] });
  expect(bulk.status).toBe(422);
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${orderId}`)).json.data.status).toBe('pending');
});

test('S7 storefront payloads never carry cost, SKU, exact stock or tenant ids', async () => {
  const payloads = [
    await sf(shop.apiHost, 'GET', '/products?page=1&per_page=24'),
    await sf(shop.apiHost, 'GET', `/products/${shop.variable.slug}`),
    await sf(shop.apiHost, 'GET', `/products/${shop.simple.slug}/availability`),
    await sf(shop.apiHost, 'GET', '/categories'),
    await sf(shop.apiHost, 'GET', `/categories/${shop.category.slug}`),
    await sf(shop.apiHost, 'GET', '/config'),
  ];
  const { order, token, cart } = await placeOrder(shop, shop.variable.variants[1].id);
  expect((await sf(shop.apiHost, 'GET', '/cart', { cart })).json.error?.code).toBe('cart_not_found'); // converted
  const live = await cartAdd(shop.apiHost, shop.variable.variants[0].id, 2);
  payloads.push(await sf(shop.apiHost, 'GET', '/cart', { cart: live.cart }));
  payloads.push(await sf(shop.apiHost, 'GET', '/orders/confirmation', { headers: { 'X-Order-Token': token } }));
  payloads.push(await sf(shop.apiHost, 'POST', '/orders/track', { json: { number: order.number, phone: order.customer_phone } }));
  for (const p of payloads) {
    expect(p.status, p.text.slice(0, 200)).toBe(200);
    expect(forbiddenKeys(p.json)).toEqual([]);
  }
  const avail = payloads[2].json.data.variants[0];
  // simple: stock 5, low threshold 5 → "Only N left" (P5-6), exact stock never otherwise
  expect(Object.keys(avail).sort()).toEqual(['available', 'id', 'low_stock']);
  expect(payloads[2].headers['cache-control']).toContain('no-store');
  const track = payloads[8].json.data;
  expect(JSON.stringify(track)).not.toContain('House 12');
  expect(JSON.stringify(track)).not.toContain('@');
  expect(Object.keys(track.shipping).sort()).toEqual(['district', 'thana']);
  // staff: unit cost null in the merchant order resource
  const id = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${order.number}`)).json.data[0].id;
  const asStaff = await api(staff.session, 'GET', `/stores/${shop.s.storeId}/orders/${id}`);
  expect(asStaff.json.data.items[0].unit_cost_amount).toBeNull();
  const asOwner = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`);
  expect(asOwner.json.data.items[0].unit_cost_amount).toBe(80000);
});

test('S8 tracking: wrong phone and unknown number give identical 404s; 11th request/min → 429', async () => {
  const { order } = await placeOrder(shop, shop.simple.variantId);
  const ip = randomIp();
  const ok = await sf(shop.apiHost, 'POST', '/orders/track', { ip, json: { number: order.number.toLowerCase(), phone: `0${order.customer_phone.slice(3)}` } });
  expect(ok.status, ok.text).toBe(200); // case-insensitive, local phone format
  const seq = order.number.split('-')[1];
  const bare = await sf(shop.apiHost, 'POST', '/orders/track', { ip, json: { number: seq, phone: order.customer_phone } });
  expect(bare.status).toBe(200); // without prefix
  const wrongPhone = await sf(shop.apiHost, 'POST', '/orders/track', { ip, json: { number: order.number, phone: randomPhone() } });
  const unknown = await sf(shop.apiHost, 'POST', '/orders/track', { ip, json: { number: 'ZZ-999999', phone: order.customer_phone } });
  expect(wrongPhone.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(wrongPhone.text).toBe(unknown.text);
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await sf(shop.apiHost, 'POST', '/orders/track', { ip, json: { number: 'ZZ-1', phone: randomPhone() } })).status);
  expect(statuses.slice(0, 6)).toEqual([404, 404, 404, 404, 404, 404]);
  expect(statuses).toContain(429);
  // the order's track view on another store's host → 404
  const preview = await api(eve.s, 'POST', `/stores/${eve.s.storeId}/preview-token`, {});
  const crossed = await sf(eve.apiHost, 'POST', '/orders/track', { preview: preview.json.data.token, json: { number: order.number, phone: order.customer_phone } });
  expect(crossed.status).toBe(404);
});

test('S9/S16 draft store: catalog 404 publicly, preview no-store, checkout 409 store_not_live; spam limits', async () => {
  expect((await sf(eve.apiHost, 'GET', '/products?page=1')).status).toBe(404);
  expect((await sf(eve.apiHost, 'GET', `/products/${eve.simple.slug}`)).status).toBe(404);
  expect((await sf(eve.apiHost, 'GET', '/categories')).status).toBe(404);
  const preview = (await api(eve.s, 'POST', `/stores/${eve.s.storeId}/preview-token`, {})).json.data.token as string;
  const pdp = await sf(eve.apiHost, 'GET', `/products/${eve.simple.slug}`, { preview });
  expect(pdp.status).toBe(200);
  expect(pdp.headers['cache-control']).toMatch(/private/);
  expect(pdp.headers['cache-control']).toMatch(/no-store/);
  const add = await sf(eve.apiHost, 'POST', '/cart/items', { preview, json: { variant_id: eve.simple.variantId, quantity: 1 } });
  expect(add.status).toBe(201);
  const r = await sf(eve.apiHost, 'POST', '/checkout', { preview, cart: add.json.meta.cart_token, idem: randomUUID(), json: checkoutBody(56000) });
  expect([r.status, r.json.error?.code]).toEqual([409, 'store_not_live']);
  expect(r.json.error.message).toBe("Your shop isn't live yet. Orders open after you go live.");
  // S9: per-IP checkout limiter (10/min): the 11th request from one IP is 429, whatever the body
  const ip = randomIp();
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await sf(shop.apiHost, 'POST', '/checkout', { ip, idem: randomUUID(), json: {} })).status);
  expect(codes.slice(0, 10).every((c) => c !== 429), codes.join(',')).toBe(true);
  expect(codes[10]).toBe(429);
  // per-phone limiter (5 per 10 min), different IPs
  const phone = randomPhone();
  const phoneCodes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const { cart } = await cartAdd(shop.apiHost, shop.simple.variantId, 1);
    phoneCodes.push((await checkout(shop.apiHost, cart, checkoutBody(1, { contact: { phone } }))).status);
  }
  expect(phoneCodes.slice(0, 5), phoneCodes.join(',')).toEqual([409, 409, 409, 409, 409]); // checkout_changed: nothing written
  expect(phoneCodes[5]).toBe(429);
});

test('S10 state machine, staff limits and refunds', async () => {
  const { order } = await placeOrder(shop, shop.simple.variantId);
  const id = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${order.number}`)).json.data[0].id as string;
  for (const a of ['ready', 'ship', 'deliver', 'return'] as const) {
    const r = await transition(shop.s, id, a, a === 'return' ? { restock: [] } : {});
    expect([a, r.status, r.json.error?.code]).toEqual([a, 409, 'invalid_state_transition']);
  }
  expect((await transition(shop.s, id, 'confirm')).status).toBe(200);
  const js = await transition(shop.s, id, 'ship', { tracking_url: 'javascript:alert(1)' });
  expect(js.status).toBe(422);
  const http = await transition(shop.s, id, 'ship', { tracking_url: 'http://tracking.example/1' });
  expect(http.status).toBe(422);
  expect((await transition(shop.s, id, 'ship', { carrier_name: 'Steadfast', tracking_code: 'SF1', tracking_url: 'https://steadfast.com.bd/t/SF1' })).status).toBe(200);
  expect((await transition(staff.session, id, 'deliver')).status).toBe(200); // staff operate
  const refund = (s: typeof shop.s, body: unknown, key: string | null = randomUUID()) =>
    apiCall(s, 'POST', `/stores/${shop.s.storeId}/orders/${id}/refunds`, { json: body, headers: key ? { 'Idempotency-Key': key } : {} });
  expect((await refund(staff.session, { amount: 100, method: 'cash' })).status).toBe(403);
  const over = await refund(shop.s, { amount: order.total_amount + 1, method: 'cash' });
  expect([over.status, over.json.error?.code]).toEqual([422, 'refund_exceeds_paid']);
  expect((await refund(shop.s, { amount: 1000, method: 'cash' }, null)).status).toBe(400);
  const key = randomUUID();
  const part = await refund(shop.s, { amount: 1000, method: 'bkash_personal', reference: 'TRX1' }, key);
  expect(part.status, part.text).toBe(201);
  const again = await refund(shop.s, { amount: 1000, method: 'bkash_personal', reference: 'TRX1' }, key);
  expect([again.status, again.json.data?.id, again.headers['idempotent-replayed']]).toEqual([201, part.json.data.id, 'true']);
  let o = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;
  expect([o.payment_status, o.paid_amount, o.refunded_amount]).toEqual(['partially_refunded', order.total_amount, 1000]);
  expect((await refund(shop.s, { amount: order.total_amount - 1000, method: 'cash' })).status).toBe(201);
  o = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;
  expect([o.payment_status, o.refunded_amount]).toEqual(['refunded', order.total_amount]);
  expect((await refund(shop.s, { amount: 1, method: 'cash' })).json.error?.code).toBe('refund_exceeds_paid');
  expect(o.events.filter((e: { type: string }) => e.type === 'refund')).toHaveLength(2);
  // staff on owner/admin-only writes
  for (const [m, p, b] of [
    ['POST', '/coupons', { code: 'STAFF1', type: 'fixed', amount: 100 }],
    ['PUT', '/shipping', { free_delivery_over_amount: null, zones: [{ name: 'Else', kind: 'fallback', charge_amount: 1, min_days: 1, max_days: 2 }] }],
    ['POST', '/publish', {}],
    ['POST', '/pickup-locations', { name: 'X', district_code: 'dhaka', thana_code: 'dhaka-dhanmondi', address_line: 'House 1, Road 2' }],
  ] as Array<[string, string, unknown]>) {
    const r = await api(staff.session, m, `/stores/${shop.s.storeId}${p}`, b);
    expect(`${m} ${p} ${r.status}`).toBe(`${m} ${p} 403`);
  }
  // staff may cancel an unpaid order but not a paid one
  const second = await placeOrder(shop, shop.simple.variantId);
  const id2 = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${second.order.number}`)).json.data[0].id as string;
  expect((await transition(staff.session, id2, 'cancel', { reason: 'unreachable', notify_customer: false })).status).toBe(200);
  const third = await placeOrder(shop, shop.simple.variantId);
  const id3 = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${third.order.number}`)).json.data[0].id as string;
  tinker(`DB::table('orders')->where('id','${id3}')->where('store_id','${shop.s.storeId}')->update(['paid_amount'=>1000,'payment_status'=>'partially_paid']); echo 'ok';`);
  const paidCancel = await transition(staff.session, id3, 'cancel', { reason: 'other' });
  // Phase 8.3: the rule is the `orders.refund` key (custom roles may hold it), so assert the stable code, not the copy.
  expect([paidCancel.status, paidCancel.json.error?.code]).toEqual([403, 'forbidden']);
  expect(paidCancel.json.error?.message).toMatch(/cancel paid orders/);
});

test('S14 /discount/{CODE} ignores ?next= and lands on / (demo host, no cart: cookie only, no DB write)', async ({ page }) => {
  await page.goto(`${urls.storefront}/discount/WELCOME10?next=https%3A%2F%2Fevil.example%2F`);
  await page.waitForURL((u) => u.pathname === '/' || u.host !== new URL(urls.storefront).host, { timeout: 15_000 });
  expect(new URL(page.url()).host).toBe(new URL(urls.storefront).host);
  expect(new URL(page.url()).pathname).toBe('/');
  await page.goto(`${urls.storefront}/discount/${encodeURIComponent('//evil.example')}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  expect(new URL(page.url()).host).toBe(new URL(urls.storefront).host);
});
