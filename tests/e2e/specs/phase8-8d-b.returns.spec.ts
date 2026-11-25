import { expect, test } from '@playwright/test';
import { createMember, signInDashboard, type ThrowawayMember } from '../support/api';
import { movementsWhere, mUrl, stockAt } from '../support/locations';
import { watchConsole } from '../support/roles';
import {
  cashSale,
  closeRaw,
  createRegisterRaw,
  gotoPos,
  historyUrl,
  ok,
  openSession,
  orderDetail,
  posShop,
  quote,
  returnByVariant,
  returnRaw,
  saleGetRaw,
  saleRaw,
  salesList,
  session,
  setCount,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part B returns at the till (§9, §11.7, P88D-17, S206; §16 AC 7), real stack:
 *  - UI cash partial return from Sales history → Return items dialog (steppers, reason, refund radios) → 201, the
 *    detail pill "Partly refunded", "Refunded − ৳ x", the row's "Return" tag, KPI Returns, stock back at the line's
 *    location (Mirpur, not online), cash in drawer down; the stepper stops at what is left.
 *  - bKash (full, pill "Refunded") and card refunds use the chosen method and never touch the drawer.
 *  - Over-return → 409 `return_not_allowed`; a cash refund above the drawer → 422 `drawer_short` (API + UI message);
 *    a closed session → 409 `register_closed`.
 *  - Close: Expected = opening + cash sales − cash refunds; counting that → "Drawer matches".
 *  - Staff (no `orders.refund`) see no Return items; the API answers 403 before the plan.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sess: Json;
let saleA: Json; // cash: wrap ×2 + kurta M ×1 = ৳ 2,200
let saleB: Json; // bKash: kurta L ×1 = ৳ 1,400
let saleC: Json; // card: wrap ×1 = ৳ 500
let staff: ThrowawayMember | undefined;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pret', 'growth', { online: 10, atShop: 5 });
  sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 100000 });
  saleA = await cashSale(shop.s, sess.id, [{ variant_id: shop.wrap, quantity: 2 }, { variant_id: shop.kurtaM, quantity: 1 }]);
  const qb = await quote(shop.s, sess.id, [{ variant_id: shop.kurtaL, quantity: 1 }]);
  saleB = await ok(await saleRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }], expected_total_amount: qb.total_amount, payments: [{ method: 'bkash_personal', amount: qb.total_amount, reference: 'TRXB1' }], sms_receipt: false }), 201, 'bkash sale');
  saleC = await ok(await saleRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'card', amount: 50000 }], sms_receipt: false }), 201, 'card sale');
  staff = await createMember(shop.s, 'staff');
});
test.afterAll(async () => {
  shop?.cleanup();
  await staff?.cleanup().catch(() => undefined);
});

test('UI: cash partial return from history → pill, Return tag, KPIs, drawer, stock back at Mirpur', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 2 });
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  await page.getByTestId('pos-history-link').click();
  await expect(page).toHaveURL(new RegExp(`/pos/history\\?session=${sess.id}`));
  const row = page.getByTestId('pos-history-row').filter({ hasText: saleA.number });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`sale=${saleA.id}`));
  const detail = page.getByTestId('pos-sale-detail');
  await expect(detail).toContainText(`Receipt ${saleA.number}`);
  await expect(detail.getByTestId('pos-sale-pill')).toHaveText('Paid');
  await detail.getByTestId('pos-return-items').click();
  const dlg = page.getByTestId('pos-return-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Return items' })).toContainText(`Receipt ${saleA.number} · stock goes back to this shop`);
  await expect(dlg.getByTestId('pos-return-line')).toHaveCount(2);
  await dlg.getByRole('button', { name: 'Return one more QA Muslin Wrap' }).click();
  await expect(dlg.getByTestId('pos-return-line').filter({ hasText: 'QA Muslin Wrap' }).getByTestId('pos-return-qty')).toHaveText('1');
  await expect(dlg.getByRole('radio', { name: 'Cash' })).toHaveAttribute('aria-checked', 'true');
  await dlg.getByTestId('pos-return-reason').selectOption('damaged');
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/pos\/sales\/[0-9A-Za-z]{26}\/returns$/.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-return-submit').click();
  const rr = await res;
  expect(rr.status(), await rr.text()).toBe(201);
  expect(rr.request().headers()['idempotency-key']).toBeTruthy();
  const sent = JSON.parse(rr.request().postData() ?? '{}');
  expect(sent).toMatchObject({ session_id: sess.id, refund_method: 'cash', reason: 'damaged' });
  const result = (await rr.json()).data as Json;
  expect(result.return_request.status).toBe('refunded');
  expect(result.refund).toMatchObject({ amount: 50000, method: 'cash', pos_session_id: sess.id });
  await expect(dlg).toBeHidden();
  await expect(detail.getByTestId('pos-sale-pill')).toHaveText('Partly refunded');
  await expect(detail).toContainText('− ৳ 500');
  await expect(row).toContainText('Return');
  await expect(page.getByTestId('pos-history-kpis')).toContainText('1 · ৳ 500');

  expect(await stockAt(shop.s, shop.wrap, shop.shop.id), 'restocked at the line location (Mirpur)').toMatchObject({ on_hand: 3 });
  expect(await stockAt(shop.s, shop.wrap, shop.main.id), 'online untouched').toMatchObject({ on_hand: 10 });
  const back = (await movementsWhere(shop.s, { location_id: shop.shop.id })).filter((m) => (m.variant?.id ?? m.variant_id) === shop.wrap && (m.delta ?? 0) > 0 && m.reason !== 'received');
  expect(back.map((m) => m.delta)).toEqual([1]);
  const s = await session(shop.s, sess.id);
  expect(s.totals).toMatchObject({ cash_refunds_amount: 50000, cash_in_drawer_amount: 100000 + 220000 - 50000, returns_count: 1, returns_amount: 50000 });

  // What's left: wrap 1 more at most.
  await detail.getByTestId('pos-return-items').click();
  const wrapLine = dlg.getByTestId('pos-return-line').filter({ hasText: 'QA Muslin Wrap' });
  await dlg.getByRole('button', { name: 'Return one more QA Muslin Wrap' }).click();
  await expect(wrapLine.getByTestId('pos-return-qty')).toHaveText('1');
  await expect(dlg.getByRole('button', { name: 'Return one more QA Muslin Wrap' }), 'stepper stops at sold − returned').toBeDisabled();
  await page.keyboard.press('Escape');
  const o = await orderDetail(shop.s, saleA.order_id);
  expect(o.return_status).toBe('partially_returned');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: bKash and card refunds use their method; over-return 409; closed session 409', async () => {
  const b = await returnByVariant(shop.s, saleB, sess.id, [[shop.kurtaL, 1]], 'bkash_personal', { reason: 'wrong_size' });
  expect(b.status, b.text.slice(0, 300)).toBe(201);
  expect(b.json.data.refund).toMatchObject({ method: 'bkash_personal', amount: 140000 });
  expect(b.json.data.sale.refunded_amount).toBe(140000);
  const c = await returnByVariant(shop.s, saleC, sess.id, [[shop.wrap, 1]], 'card');
  expect(c.status, c.text.slice(0, 300)).toBe(201);
  expect(c.json.data.refund).toMatchObject({ method: 'card', amount: 50000 });
  const s = await session(shop.s, sess.id);
  expect(s.totals.cash_in_drawer_amount, 'non-cash refunds never touch the drawer').toBe(270000);
  expect(s.totals.returns_count).toBe(3);

  const over = await returnByVariant(shop.s, saleA, sess.id, [[shop.wrap, 2]], 'cash');
  expect([over.status, over.json.error?.code]).toEqual([409, 'return_not_allowed']);
  const none = await returnByVariant(shop.s, saleB, sess.id, [[shop.kurtaL, 1]], 'cash');
  expect([none.status, none.json.error?.code], 'fully returned sale').toEqual([409, 'return_not_allowed']);
  const badReason = await returnByVariant(shop.s, saleA, sess.id, [[shop.wrap, 1]], 'cash', { reason: 'free text' });
  expect(badReason.status).toBe(422);
  const noKey = await returnRaw(shop.s, saleA.id, { session_id: sess.id, lines: [], refund_method: 'cash' }, shop.s, null);
  expect([noKey.status, noKey.json.error?.code]).toEqual([400, 'idempotency_key_required']);
});

test('drawer_short: cash refund above the drawer → 422 (API + UI message); card works', async ({ page, context }) => {
  test.setTimeout(120_000);
  const r2 = await ok(await createRegisterRaw(shop.s, { name: 'Register 2', location_id: shop.shop.id }), 201, 'register 2');
  const s2 = await openSession(shop.s, r2.id, { opening_cash_amount: 0 });
  const api = await returnByVariant(shop.s, saleA, s2.id, [[shop.kurtaM, 1]], 'cash');
  expect([api.status, api.json.error?.code]).toEqual([422, 'drawer_short']);

  await signInDashboard(context, shop.s);
  await page.goto(mUrl(historyUrl(s2.id, `&sale=${saleA.id}`)));
  const detail = page.getByTestId('pos-sale-detail');
  await expect(detail).toContainText(`Receipt ${saleA.number}`, { timeout: 20_000 });
  await detail.getByTestId('pos-return-items').click();
  const dlg = page.getByTestId('pos-return-dialog');
  await dlg.getByRole('button', { name: 'Return one more QA Cotton Kurta' }).click();
  await dlg.getByRole('radio', { name: 'Cash' }).click();
  await page.getByTestId('pos-return-submit').click();
  await expect(page.getByTestId('pos-return-error')).toContainText('There isn’t enough cash in the drawer for this refund');
  await dlg.getByRole('radio', { name: 'Card' }).click();
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/returns$/.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-return-submit').click();
  expect((await res).status()).toBe(201);
  await expect(dlg).toBeHidden();
  await expect(detail.getByTestId('pos-sale-pill')).toHaveText('Partly refunded');
  expect(await stockAt(shop.s, shop.kurtaM, shop.shop.id)).toMatchObject({ on_hand: 5 });

  const closed = await session(shop.s, s2.id);
  expect((await closeRaw(shop.s, s2.id, { counted_cash_amount: 0, left_in_drawer_amount: 0, revision: closed.revision })).status).toBe(200);
  const late = await returnByVariant(shop.s, saleA, s2.id, [[shop.wrap, 1]], 'card');
  expect([late.status, late.json.error?.code]).toEqual([409, 'register_closed']);
});

test('close: Expected = opening + cash sales − cash refunds; counting it → Drawer matches', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}/close`);
  await expect(page.getByText('− Cash refunds', { exact: true }).first().locator('..')).toContainText('৳ 500');
  await expect(page.getByTestId('pos-expected')).toHaveText('৳ 2,700');
  await setCount(page, 100000, 2);
  await setCount(page, 50000, 1);
  await setCount(page, 20000, 1);
  await expect(page.getByTestId('pos-variance')).toContainText('Drawer matches');
  await expect(page.getByText('Returns', { exact: true }).first().locator('..')).toContainText('3 · ৳ 2,400');
});

test('staff without orders.refund: no Return items; API 403 (before the plan)', async ({ page, context }) => {
  const st = { ...staff!.session, storeId: shop.s.storeId };
  const r = await returnByVariant(st, saleA, sess.id, [[shop.wrap, 1]], 'card');
  expect([r.status, r.json.error?.code]).toEqual([403, 'forbidden']);
  expect((await saleGetRaw(shop.s, saleA.id, st)).status, 'staff can read the receipt').toBe(200);
  expect((await salesList(st, '')).data.length).toBeGreaterThan(0);
  await signInDashboard(context, st);
  await page.goto(mUrl(historyUrl(sess.id, `&sale=${saleA.id}`)));
  const detail = page.getByTestId('pos-sale-detail');
  await expect(detail).toContainText(`Receipt ${saleA.number}`, { timeout: 20_000 });
  await expect(detail.getByTestId('pos-reprint')).toBeVisible();
  await expect(detail.getByTestId('pos-return-items')).toHaveCount(0);
});
