import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { movementsWhere, stockAt } from '../support/locations';
import { watchConsole } from '../support/roles';
import {
  cart,
  chargeTotal,
  gotoPos,
  openSession,
  ordersWhere,
  paymentDialog,
  posShop,
  saleComplete,
  saleRaw,
  stubPrint,
  tile,
  WRAP,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D one sale per attempt (P88D-21, S200, §16 AC 4):
 *  - UI: a double-click on Charge opens one payment dialog and a double-click on Complete sends at most one key → one
 *    order, one ledger row, stock −1 once.
 *  - UI: the response of the first Complete is lost on the wire (the server did sell) → "We couldn’t reach the server…",
 *    the till goes Offline until the session probe answers, then Complete again reuses the same Idempotency-Key and
 *    gets the first sale back → still one order.
 *  - API: no key → 400 `idempotency_key_required`; same key + body twice (and in parallel) → one order; same key +
 *    other body → 409 `idempotency_key_mismatch`.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sess: Json;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pdbl', 'growth', { online: 10, atShop: 10 });
  sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 0 });
});
test.afterAll(() => shop?.cleanup());

const posOrders = () => ordersWhere(shop.s, 'filter[created_via]=pos');
const wrapLedger = async () => (await movementsWhere(shop.s, { reason: 'pos_sale' })).filter((m) => (m.variant?.id ?? m.variant_id) === shop.wrap);

test('UI: double-click Charge and Complete → one order', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  const posts: Array<string | null> = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/pos\/sales$/.test(new URL(r.url()).pathname)) posts.push(r.headers()['idempotency-key'] ?? null);
  });
  await gotoPos(page, `/pos/${sess.id}`);
  await tile(page, WRAP).click();
  expect(await chargeTotal(page)).toBe(50000);
  await cart(page).getByTestId('pos-charge').dblclick();
  await expect(page.getByRole('dialog', { name: 'Take payment' }), 'one payment dialog stays open (P88DA-QA-3)').toHaveCount(1);
  await paymentDialog(page).getByTestId('pos-complete-sale').dblclick();
  await expect(saleComplete(page)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(posts.length, `sale POSTs ${posts.length}`).toBeGreaterThanOrEqual(1);
  expect(new Set(posts).size, 'every POST of the attempt carries the same key').toBe(1);
  expect(posts[0]).toBeTruthy();
  expect(await posOrders()).toHaveLength(1);
  expect(await wrapLedger()).toHaveLength(1);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 9 });
  await saleComplete(page).getByTestId('pos-new-sale').click();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('UI: lost response → Offline → Complete again replays the first sale (same key, one order)', async ({ page, context }) => {
  test.setTimeout(120_000);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  const seen: Array<{ key: string | null; status: number | 'aborted' }> = [];
  let first = true;
  await page.route(/\/api\/v1\/stores\/[^/]+\/pos\/sales$/, async (route) => {
    const key = route.request().headers()['idempotency-key'] ?? null;
    if (first && route.request().method() === 'POST') {
      first = false;
      const res = await route.fetch(); // the server sells…
      seen.push({ key, status: 'aborted' });
      expect(res.status()).toBe(201);
      return route.abort('internetdisconnected'); // …but the till never hears back
    }
    const res = await route.fetch();
    seen.push({ key, status: res.status() });
    return route.fulfill({ response: res });
  });
  await gotoPos(page, `/pos/${sess.id}`);
  await tile(page, WRAP).click();
  await cart(page).getByRole('radio', { name: 'Card' }).click();
  await cart(page).getByTestId('pos-charge').click();
  const pay = paymentDialog(page);
  await pay.getByTestId('pos-complete-sale').click();
  await expect(pay.getByTestId('pos-payment-error')).toContainText('We couldn’t reach the server');
  await expect(page.getByTestId('pos-online-pill')).toContainText('Offline — reconnect to charge');
  // The 5 s session probe brings the till back online; Complete again.
  await expect(page.getByTestId('pos-online-pill')).toContainText('Online', { timeout: 20_000 });
  await expect(pay.getByTestId('pos-complete-sale')).toBeEnabled();
  await pay.getByTestId('pos-complete-sale').click();
  await expect(saleComplete(page)).toBeVisible();
  expect(seen.map((x) => x.status)).toEqual(['aborted', 201]);
  expect(seen[0]!.key, 'retry reuses the attempt key (S200)').toBe(seen[1]!.key);
  expect(await posOrders(), 'still one more order, not two').toHaveLength(2);
  expect(await wrapLedger()).toHaveLength(2);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 8 });
});

test('API: key required; same key replays (also in parallel); other body → 409', async () => {
  const b = (qty: number) => ({
    session_id: sess.id,
    lines: [{ variant_id: shop.wrap, quantity: qty }],
    expected_total_amount: 50000 * qty,
    payments: [{ method: 'card', amount: 50000 * qty }],
    sms_receipt: false,
  });
  const none = await saleRaw(shop.s, b(1), shop.s, null);
  expect([none.status, none.json.error?.code]).toEqual([400, 'idempotency_key_required']);

  const key = { 'Idempotency-Key': randomUUID() };
  const [r1, r2] = await Promise.all([saleRaw(shop.s, b(1), shop.s, key), saleRaw(shop.s, b(1), shop.s, key)]);
  const ok = [r1, r2].filter((r) => r.status === 201);
  expect(ok.length, `parallel same-key statuses ${r1.status}/${r2.status}: ${r1.text.slice(0, 120)} | ${r2.text.slice(0, 120)}`).toBeGreaterThanOrEqual(1);
  for (const r of [r1, r2]) expect([201, 409]).toContain(r.status);
  const replay = await saleRaw(shop.s, b(1), shop.s, key);
  expect(replay.status).toBe(201);
  expect(replay.json.data.order_id).toBe(ok[0]!.json.data.order_id);
  const mismatch = await saleRaw(shop.s, b(2), shop.s, key);
  expect([mismatch.status, mismatch.json.error?.code]).toEqual([409, 'idempotency_key_mismatch']);
  expect(await posOrders()).toHaveLength(3);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 7 });
});

// Regression for P88DA-QA-3 (fixed in 6cb0a78).
test('a double-click on Charge leaves the payment dialog open', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  await tile(page, WRAP).click();
  await chargeTotal(page);
  await cart(page).getByTestId('pos-charge').dblclick();
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog', { name: 'Take payment' }), 'the 2nd click on the backdrop does not close it').toHaveCount(1);
});
