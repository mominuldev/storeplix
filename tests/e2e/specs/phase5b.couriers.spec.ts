import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, createTenant, signInDashboard, urls, type ThrowawayTenant } from '../support/api';
import {
  bookShipment,
  browserHost,
  confirmedOrder,
  connectFakeCourier,
  ensurePickup,
  fakeAdvance,
  fakeCourierCredentials,
  fakeParcelState,
  leaks,
  merchantOrder,
  setPlan,
  setupShop,
  shipmentDetail,
  shipmentList,
  steadfastWebhook,
  waitOrderStatus,
  type CommerceShop,
} from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "couriers" (P5B-31…P5B-43, §4.3 courier webhooks, §4.6, §4.7, §6.4, §11 `/track`, S25, S32).
 * Fake courier only (COURIERS_FAKE=true, API-C1/C2's FakeCourier): connect Steadfast in the dashboard → book from the
 * order detail → Steadfast-style webhook with the bearer secret → shipped → delivered (COD collected, order delivered)
 * → Shipments KPIs; bulk book 3 orders; forged / replayed / foreign webhooks have no effect; the poll path (refresh
 * re-queries the courier) and the dev fake-advance path; `/track` shows the courier status.
 *
 * The fake parcel state lives in the API's tenant cache: everything that flushes the cache (browserHost, setPlan) runs
 * in beforeAll, before any booking.
 */
let shop: CommerceShop;
let secret: string;
let webhookUrl: string;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('cour', { stock: 40 });
  setPlan(shop.s, 'starter'); // bulk_courier_booking (P5B-31)
  browserHost(shop);
  await ensurePickup(shop.s);
});
test.afterAll(() => shop?.cleanup());

// ----- UI helpers (selectors from WEB-1/WEB-2 source; one helper each) -----

/** Integrations → "Connect Steadfast Courier" → credentials (Sandbox) → Booking rules → Status updates (URL + token once). */
async function connectSteadfastInDashboard(page: Page, creds: { api_key: string; secret_key: string }): Promise<{ url: string; token: string }> {
  await page.goto(`${urls.merchant}/integrations`);
  await page.getByRole('button', { name: 'Connect Steadfast Courier' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Enter your Steadfast credentials')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Sandbox (test)' }).click();
  await dialog.getByRole('textbox', { name: 'API key' }).fill(creds.api_key);
  await dialog.getByRole('textbox', { name: 'Secret key' }).fill(creds.secret_key);
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog.getByText('Booking rules')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByLabel('Pickup from')).not.toHaveValue('');
  await dialog.getByRole('button', { name: /^Save( and continue)?$/ }).click();
  await expect(dialog.getByText('Status updates')).toBeVisible({ timeout: 20_000 });
  const url = await dialog.getByLabel('Webhook URL').inputValue();
  const token = await dialog.getByLabel('Bearer token').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  return { url, token };
}

/** Order detail courier card "Book with Steadfast" → dialog "Book {number} with Steadfast" → "Book with Steadfast". */
async function bookFromOrderDetail(page: Page, orderId: string, number: string): Promise<void> {
  await page.goto(`${urls.merchant}/orders/${orderId}`);
  await page.getByRole('button', { name: 'Book with Steadfast' }).first().click();
  const dialog = page.getByRole('dialog', { name: `Book ${number} with Steadfast` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Book with Steadfast' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

const kpiTile = (page: Page, label: string) => page.getByRole('group', { name: 'Shipment KPIs' }).locator('div').filter({ hasText: label }).first();

// ----- tests -----

test('connect fake Steadfast from Integrations: credentials checked, token shown once, never echoed', async ({ page, context }) => {
  test.setTimeout(120_000);
  // API: bad keys → 422 credentials_invalid (field-level), nothing stored
  const bad = await api(shop.s, 'PUT', `/stores/${shop.s.storeId}/couriers/steadfast`, { mode: 'sandbox', credentials: { api_key: 'invalid-key', secret_key: 'x-secret' } });
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'credentials_invalid']);

  const creds = fakeCourierCredentials('steadfast') as { api_key: string; secret_key: string };
  await signInDashboard(context, shop.s);
  const ui = await connectSteadfastInDashboard(page, creds);
  expect(ui.token).toMatch(/^[A-Za-z0-9]{40}$/);
  expect(ui.url).toMatch(/\/api\/v1\/webhooks\/steadfast\/[A-Za-z0-9]{32}$/);
  await expect(page.getByRole('article', { name: 'Steadfast Courier' }).getByText('Connected')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('integrations-connected.png'), fullPage: true });
  secret = ui.token;
  webhookUrl = ui.url;

  const list = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/couriers`);
  expect(list.status).toBe(200);
  expect((list.json.data as { provider: string }[]).map((a) => a.provider).sort()).toEqual(['pathao', 'redx', 'steadfast']);
  const sf = (list.json.data as { provider: string; status: string; webhook_url: string; is_default: boolean }[]).find((a) => a.provider === 'steadfast')!;
  expect([sf.status, sf.webhook_url]).toEqual(['connected', webhookUrl]);
  // S26: no secret half and no webhook token in any read
  expect(leaks(list.json, [creds.secret_key, secret])).toEqual([]);
  const t = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/couriers/steadfast/test`, {});
  expect([t.status, t.json.data?.ok, t.json.data?.balance_amount]).toEqual([200, true, 1234500]);
  expect(leaks(t.json, [creds.secret_key, secret])).toEqual([]);
  if (!sf.is_default) {
    const acc = (list.json.data as { provider: string; revision: number }[]).find((a) => a.provider === 'steadfast')!;
    expect((await api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/couriers/steadfast`, { revision: acc.revision, is_default: true })).status).toBe(200);
  }
});

test('book from the order detail → signed webhook → shipped → delivered (COD collected) → Shipments KPIs', async ({ page, context }) => {
  test.setTimeout(180_000);
  expect(secret, 'connect test must run first').toBeTruthy();
  const order = await confirmedOrder(shop, shop.simple.variantId, 2); // 2 × ৳500 + ৳60 = ৳1,060 COD
  await signInDashboard(context, shop.s);
  await bookFromOrderDetail(page, order.id, order.number);

  const booked = await merchantOrder(shop.s, order.id);
  expect(booked.status).toBe('ready_to_ship');
  const shipment = booked.shipment as { id: string; provider: string; status: string; consignment_id: string; cod_amount: number };
  expect([shipment.provider, shipment.status, shipment.cod_amount]).toEqual(['steadfast', 'booked', 106000]);
  expect(shipment.consignment_id).toMatch(/^FK[0-9A-F]{10}$/);
  await expect(page.getByText(shipment.consignment_id).first()).toBeVisible();

  // Idempotent API replay and the one-active-shipment rule (P5B-33)
  const key = randomUUID();
  const again = await bookShipment(shop.s, order.id, {}, key);
  expect([again.status, again.json.error?.code]).toEqual([409, 'shipment_booked']);

  // Steadfast-style webhook, Bearer secret: picked up → order shipped (InventoryService::ship)
  const base = { consignment_id: shipment.consignment_id, invoice: shipment.id };
  const w1 = await steadfastWebhook(webhookUrl, secret, { ...base, status: 'in_transit', occurred_at: new Date().toISOString() });
  expect(w1.status, w1.text).toBe(200);
  expect(leaks(w1.text, [order.phone, order.number])).toEqual([]); // no tenant data in webhook answers
  await waitOrderStatus(shop.s, order.id, 'shipped');

  // S32: "delivered" while the courier's own API still says in_transit → re-queried → no money/order effect
  fakeParcelState(shop.s.tenantId, shipment.id, 'in_transit');
  const spoof = await steadfastWebhook(webhookUrl, secret, { ...base, status: 'delivered', cod_collected_amount: 106000, occurred_at: new Date(Date.now() + 1000).toISOString() });
  expect(spoof.status, spoof.text).toBe(200);
  await page.waitForTimeout(4000); // queue worker
  expect((await merchantOrder(shop.s, order.id)).status).toBe('shipped');
  expect((await shipmentDetail(shop.s, shipment.id)).status).not.toBe('delivered');

  // The courier really delivered: its API agrees → order delivered, COD charge succeeded with the collected amount
  fakeParcelState(shop.s.tenantId, shipment.id, 'delivered');
  const w2 = await steadfastWebhook(webhookUrl, secret, { ...base, status: 'delivered', occurred_at: new Date(Date.now() + 2000).toISOString() });
  expect(w2.status, w2.text).toBe(200);
  const delivered = await waitOrderStatus(shop.s, order.id, 'delivered');
  expect([delivered.payment_status, delivered.paid_amount, delivered.due_amount]).toEqual(['paid', 106000, 0]);
  const cod = (delivered.payments as { type: string; provider: string; status: string; amount: number }[]).find((p) => p.type === 'charge' && p.provider === 'cod');
  expect([cod?.status, cod?.amount]).toEqual(['succeeded', 106000]);
  const detail = await shipmentDetail(shop.s, shipment.id);
  expect([detail.status, detail.cod_collected_amount]).toEqual(['delivered', 106000]);
  const sources = (detail.events as { status: string; source: string }[]).map((e) => `${e.status}:${e.source}`);
  expect(sources).toEqual(expect.arrayContaining(['in_transit:webhook', 'delivered:webhook']));
  // rider data never reaches the merchant timeline from the scrubbed raw payload either
  expect(JSON.stringify(detail)).not.toContain(secret);

  // Shipments page KPIs (39:10347) agree with the API meta
  const { meta } = await shipmentList(shop.s);
  expect(meta.kpis.delivered_7d).toBeGreaterThanOrEqual(1);
  expect(meta.kpis.cod_held.total_amount).toBeGreaterThanOrEqual(106000);
  await page.goto(`${urls.merchant}/shipments`);
  await expect(page.getByRole('heading', { name: 'Shipments' }).first()).toBeVisible();
  await expect(kpiTile(page, 'Delivered this week')).toContainText(String(meta.kpis.delivered_7d));
  await expect(kpiTile(page, 'COD held by couriers')).toContainText(/1,060/);
  await expect(page.getByText(order.number).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('shipments-kpis.png'), fullPage: true });
});

test('forged, replayed and foreign webhooks have no effect (S25, S24, S32)', async () => {
  test.setTimeout(120_000);
  const order = await confirmedOrder(shop);
  const b = await bookShipment(shop.s, order.id);
  expect(b.status, b.text).toBe(201);
  const sh = b.json.data as { id: string; consignment_id: string };
  const base = { consignment_id: sh.consignment_id, invoice: sh.id };
  const eventsOf = async () => ((await shipmentDetail(shop.s, sh.id)).events as unknown[]).length;
  const before = await eventsOf();

  // wrong bearer / no bearer → 401, nothing stored; unknown route key → 404
  for (const token of ['x'.repeat(40), null]) {
    const r = await steadfastWebhook(webhookUrl, token, { ...base, status: 'in_transit' });
    expect(r.status, r.text).toBe(401);
  }
  const unknown = await steadfastWebhook(webhookUrl.replace(/[A-Za-z0-9]{32}$/, 'Z'.repeat(32)), secret, { ...base, status: 'in_transit' });
  expect(unknown.status).toBe(404);
  // a provider with another word in the path → 404
  expect((await steadfastWebhook(webhookUrl.replace('/steadfast/', '/sundarban/'), secret, base)).status).toBe(404);
  await new Promise((r) => setTimeout(r, 3000));
  expect(await eventsOf()).toBe(before);
  expect((await merchantOrder(shop.s, order.id)).status).toBe('ready_to_ship');

  // the same event twice → one event, one effect
  const ev = { ...base, status: 'in_transit', event_id: `qa-${randomUUID()}`, occurred_at: new Date().toISOString() };
  const r1 = await steadfastWebhook(webhookUrl, secret, ev);
  const r2 = await steadfastWebhook(webhookUrl, secret, ev);
  expect([r1.status, r2.status]).toEqual([200, 200]);
  await waitOrderStatus(shop.s, order.id, 'shipped');
  await new Promise((r) => setTimeout(r, 3000));
  const inTransit = ((await shipmentDetail(shop.s, sh.id)).events as { status: string }[]).filter((e) => e.status === 'in_transit');
  expect(inTransit).toHaveLength(1);

  // S32: tenant B's consignment on A's route key (with A's valid secret) is ignored — looked up inside A only
  let other: ThrowawayTenant | null = null;
  try {
    other = await createTenant('cour-b');
    const shopB = { s: other.session } as CommerceShop;
    await ensurePickup(shopB.s);
    const accB = await connectFakeCourier(shopB.s, 'steadfast');
    // B's parcel id shape on A's key: no shipment in A has it → acknowledged, nothing changes anywhere
    const forged = await steadfastWebhook(webhookUrl, secret, { consignment_id: 'FK0000000000', invoice: '01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'delivered' });
    expect([200, 404]).toContain(forged.status);
    // A's consignment on B's route key with B's secret → not found in B → A unchanged
    const cross = await steadfastWebhook(accB.webhookUrl!, accB.webhookSecret, { ...base, status: 'delivered', occurred_at: new Date(Date.now() + 5000).toISOString() });
    expect([200, 404]).toContain(cross.status);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await merchantOrder(shop.s, order.id)).status).toBe('shipped');
  } finally {
    other?.cleanup();
  }
});

test('poll path: Sync now and Refresh re-query the courier; dev fake-advance moves a parcel end to end', async () => {
  test.setTimeout(120_000);
  const order = await confirmedOrder(shop);
  const b = await bookShipment(shop.s, order.id);
  expect(b.status, b.text).toBe(201);
  const id = b.json.data.id as string;

  // the courier moved the parcel but sent no webhook: "Sync now" queues the 15-min poll job for every active parcel
  fakeParcelState(shop.s.tenantId, id, 'picked_up');
  const sync = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/sync`, {});
  expect(sync.status, JSON.stringify(sync.json)).toBe(202);
  expect(sync.json.data.queued).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await shipmentDetail(shop.s, id)).status, { timeout: 30_000, message: 'queue worker (default)' }).toBe('picked_up');
  const polled = await shipmentDetail(shop.s, id);
  expect((polled.events as { status: string; source: string }[]).some((e) => e.status === 'picked_up' && e.source === 'poll')).toBe(true);
  expect((await merchantOrder(shop.s, order.id)).status).toBe('shipped'); // first pickup signal ships the order
  // second "Sync now" inside a minute → 429 (P5B-38)
  expect((await api(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/sync`, {})).status).toBe(429);

  // "Refresh" on one parcel re-queries the courier at once (source user)
  fakeParcelState(shop.s.tenantId, id, 'out_for_delivery');
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/${id}/refresh`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.data.status).toBe('out_for_delivery');
  expect((r.json.data.events as { status: string; source: string }[]).some((e) => e.status === 'out_for_delivery' && e.source === 'user')).toBe(true);

  // dev fake-advance (testing-only endpoint, applied like a courier webhook): delivered → order delivered, COD paid
  const adv = await fakeAdvance(id, 'delivered');
  expect(adv.status, adv.text).toBe(200);
  expect([adv.json.data.status, adv.json.data.order_status]).toEqual(['delivered', 'delivered']);
  const o = await merchantOrder(shop.s, order.id);
  expect([o.payment_status, o.due_amount]).toEqual(['paid', 0]);
  // unknown shipment → 404; bad status → 422
  expect((await fakeAdvance('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'delivered')).status).toBe(404);
  expect((await fakeAdvance(id, 'teleported')).status).toBe(422);
});

test('bulk book 3 orders (Starter): batch books all three, orders ready to ship', async ({ page, context }) => {
  test.setTimeout(150_000);
  const orders = [await confirmedOrder(shop), await confirmedOrder(shop), await confirmedOrder(shop)];
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/bulk`, { provider: 'steadfast', order_ids: orders.map((o) => o.id) });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(r.json.data.total).toBe(3);
  const batchId = r.json.data.id as string;
  await expect
    .poll(async () => (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/shipment-batches/${batchId}`)).json.data.status, { timeout: 60_000, message: 'bulk queue worker' })
    .toBe('completed');
  const batch = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/shipment-batches/${batchId}`)).json.data;
  expect([batch.booked, batch.skipped, batch.failed]).toEqual([3, 0, 0]);
  expect((batch.results as { status: string; order_number: string }[]).map((x) => x.status)).toEqual(['booked', 'booked', 'booked']);
  for (const o of orders) {
    const m = await merchantOrder(shop.s, o.id);
    expect([m.status, m.shipment?.provider, m.shipment?.status]).toEqual(['ready_to_ship', 'steadfast', 'booked']);
  }
  // unknown order id → 422 on the path, nothing queued
  const bad = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/bulk`, { provider: 'steadfast', order_ids: [orders[0].id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'] });
  expect([bad.status, Object.keys(bad.json.error?.details ?? {})]).toEqual([422, ['order_ids.1']]);

  // Shipments page lists them under Steadfast
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/shipments`);
  for (const o of orders) await expect(page.getByText(o.number).first()).toBeVisible({ timeout: 15_000 });
});

test('Free plan: bulk booking 402 feature_not_in_plan', async () => {
  const t = await createTenant('cour-free');
  try {
    // the plan switch flushes the cache: fine here, this tenant books nothing
    setPlan(t.session, 'free');
    const r = await api(t.session, 'POST', `/stores/${t.session.storeId}/shipments/bulk`, { provider: 'steadfast', order_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] });
    expect([r.status, r.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
  } finally {
    t.cleanup();
  }
});

test('/track shows the courier status and the courier link (status + time only)', async ({ page }) => {
  test.setTimeout(120_000);
  const order = await confirmedOrder(shop);
  const b = await bookShipment(shop.s, order.id);
  expect(b.status, b.text).toBe(201);
  const id = b.json.data.id as string;
  expect((await fakeAdvance(id, 'in_transit')).status).toBe(200);
  const adv = await fakeAdvance(id, 'out_for_delivery');
  expect([adv.status, adv.json.data?.order_status]).toEqual([200, 'shipped']);

  await page.goto(`${shop.storefront}/track`);
  await page.getByLabel('Order number').fill(order.number);
  await page.getByLabel('Phone number').fill(order.phone);
  await page.getByRole('button', { name: /Track order/ }).click();
  const result = page.locator('[data-sp-tracking]');
  await expect(result.getByRole('heading', { name: 'On the way to you' })).toBeVisible({ timeout: 20_000 });
  await expect(result.getByText(/Steadfast/).first()).toBeVisible();
  await expect(result.getByText('Out for delivery')).toBeVisible();
  await expect(result.locator('[data-sp-courier-checked]')).toContainText('Courier status is checked with the courier directly');
  await page.screenshot({ path: test.info().outputPath('track-courier.png'), fullPage: true });
});
