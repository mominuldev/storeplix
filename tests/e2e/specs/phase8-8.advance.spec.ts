import { expect, test } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import { connectFakeGateway, merchantOrder, paymentLinks, randomPhone, type CommerceShop } from '../support/commerce';
import { buildRecord, guardEvents, guardShop, holdTag, mUrl, overview, payLink, placeCod, waitGuard } from '../support/fraud-guard';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-8 §13 QA "careful buyer → advance" (P88-4, P88-5, §5.2 step 5, §5.3; S158; AC 1, AC 2):
 * a phone with 1 delivered / 1 returned at this shop (total < 3 with a return → `careful`) places a storefront COD order
 * on a shop with a connected (fake) bKash gateway → the guard asks for the delivery charge in advance through the
 * existing payment link (amount kind `delivery_charge` = ৳ 60, expiry 1 440 min, cancel-if-unpaid on) and holds the
 * order `advance` ("Waiting for advance" tag, "Confirm without advance"); confirm → 409 `order_held`; the shopper pays
 * the link on the fake gateway → the hold is released and the order confirms itself once; decision log has
 * `advance_asked` + `advance_paid`; the overview's "Advance collected" counts it (Q191).
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const careful = randomPhone();
let orderId = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await guardShop('fga', 'growth');
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
  await buildRecord(shop, careful, 1, 1);
});
test.afterAll(() => shop?.cleanup());

test('careful buyer → advance link (delivery charge, 24 h, cancel if unpaid), order held "advance" (S158)', async () => {
  test.setTimeout(120_000);
  const placed = await placeCod(shop, careful);
  const o = await waitGuard(shop.s, placed.id);
  expect(o.status).toBe('pending');
  expect(o.guard).toMatchObject({ hold: 'advance', decision: 'advance', tier: 'careful' });
  expect(o.guard.payment_link_id, 'the check stores its link').toBeTruthy();
  expect((o.guard.reasons as string[]).length, 'every decision is explained').toBeGreaterThan(0);

  const links = await paymentLinks(shop.s, placed.id);
  expect(links).toHaveLength(1);
  const [link] = links;
  expect(link.id).toBe(o.guard.payment_link_id);
  expect([link.status, link.amount_kind, link.amount, link.cancel_if_unpaid]).toEqual(['active', 'delivery_charge', 6000, true]);
  const minutes = (Date.parse(link.expires_at) - Date.parse(link.created_at)) / 60_000;
  expect(minutes).toBeGreaterThan(1439);
  expect(minutes).toBeLessThan(1441);

  const confirm = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/${placed.id}/confirm`, {});
  expect([confirm.status, confirm.json.error?.code]).toEqual([409, 'order_held']);
  expect((await guardEvents(shop.s, 'advance_asked')).some((e) => e.order?.id === placed.id)).toBe(true);
  orderId = placed.id;
});

test('UI: "Waiting for advance" tag and the advance banner actions', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(`/orders/${orderId}`));
  await expect(holdTag(page, 'Waiting for advance')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /Confirm without advance/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend link/ }).or(page.getByRole('button', { name: /Copy payment link/ })).first()).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('fake gateway pays the link → hold released, order confirmed once, advance collected (S158, AC 2)', async () => {
  test.setTimeout(120_000);
  const [link] = await paymentLinks(shop.s, orderId);
  await payLink(shop, link.url as string);
  await expect.poll(async () => (await merchantOrder(shop.s, orderId)).status, { timeout: 30_000, message: 'order confirmed by the paid link' }).toBe('confirmed');
  const o = await merchantOrder(shop.s, orderId);
  expect(o.guard?.hold ?? null).toBeNull();
  expect([o.payment_status, o.paid_amount]).toEqual(['partially_paid', 6000]);
  const toConfirmed = ((o.events ?? []) as Array<{ type: string; to_status: string | null }>).filter((e) => e.type === 'status_changed' && e.to_status === 'confirmed');
  expect(toConfirmed.length, 'confirmed exactly once').toBe(1);
  expect((await paymentLinks(shop.s, orderId))[0].status).toBe('paid');
  expect((await guardEvents(shop.s, 'advance_paid')).some((e) => e.order?.id === orderId)).toBe(true);
  const ov = await overview(shop.s);
  expect(ov.advance_collected_amount).toBeGreaterThanOrEqual(6000);
});
