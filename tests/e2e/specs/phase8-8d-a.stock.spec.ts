import { expect, test } from '@playwright/test';
import { apiCall, signInDashboard } from '../support/api';
import { movementsWhere, stockAt } from '../support/locations';
import { watchConsole } from '../support/roles';
import {
  cart,
  cashSale,
  chargeTotal,
  gotoPos,
  KURTA,
  lookupRaw,
  MIRPUR,
  ok,
  openSession,
  ordersWhere,
  paymentDialog,
  posShop,
  quote,
  quoteRaw,
  saleComplete,
  saleRaw,
  saleResponse,
  stubPrint,
  tile,
  WRAP,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D stock at the register location (P88D-6, S199, §16 AC 4; §5.3 scan; §11.9 out-of-stock inline):
 *  - API: a sale above the register location's available → 422 `out_of_stock` with `details["lines.0.quantity"] =
 *    ["Only n left at Mirpur shop."]` and nothing written; a sale takes stock only at Mirpur (online Main untouched),
 *    one `pos_sale` ledger row per line referencing the order; at 0 the next sale is refused.
 *  - Scan: exact, case-insensitive SKU → that variant; `%` / `_` are literal (404 `pos_code_not_found`); > 64 → 422.
 *  - UI: an out-of-stock product tile is disabled ("Out of stock"); the picker stops at the shop's stock; stock taken by
 *    another till while the payment dialog is open → 422 → inline line error + "Refresh cart", no order; fixing the cart
 *    sells. Enter in the search box adds a scanned SKU straight to the cart.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sess: Json;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('pstk', 'growth', { online: 10, atShop: 2 });
  sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 0 });
});
test.afterAll(() => shop?.cleanup());

const body = (variant: string, quantity: number, total: number) => ({
  session_id: sess.id,
  lines: [{ variant_id: variant, quantity }],
  expected_total_amount: total,
  payments: [{ method: 'card', amount: total }],
  sms_receipt: false,
});

test('API: never beyond available at the register location; ledger pos_sale at Mirpur only; scan rules', async () => {
  const over = await saleRaw(shop.s, body(shop.wrap, 3, 150000));
  expect([over.status, over.json.error?.code], over.text.slice(0, 300)).toEqual([422, 'out_of_stock']);
  expect(over.json.error?.details?.['lines.0.quantity']).toEqual([`Only 2 left at ${MIRPUR}.`]);
  expect(await ordersWhere(shop.s, 'filter[created_via]=pos')).toHaveLength(0);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 2 });

  const q = await quote(shop.s, sess.id, [{ variant_id: shop.wrap, quantity: 3 }]);
  expect(q.lines[0], 'quote flags the short line').toMatchObject({ available: 2, problem: expect.stringMatching(/stock/) });

  const sale = await cashSale(shop.s, sess.id, [{ variant_id: shop.wrap, quantity: 2 }]);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 0, available: 0 });
  expect(await stockAt(shop.s, shop.wrap, shop.main.id), 'online location untouched').toMatchObject({ on_hand: 10, available: 10 });
  const ledger = (await movementsWhere(shop.s, { reason: 'pos_sale' })).filter((m) => (m.variant?.id ?? m.variant_id) === shop.wrap);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ reason: 'pos_sale' });
  expect(ledger[0].delta ?? ledger[0].quantity).toBe(-2);
  expect(ledger[0].location?.id ?? ledger[0].location_id).toBe(shop.shop.id);
  expect(ledger[0].reference).toEqual({ type: 'order', id: sale.order_id });

  const zero = await saleRaw(shop.s, body(shop.wrap, 1, 50000));
  expect([zero.status, zero.json.error?.code]).toEqual([422, 'out_of_stock']);
  expect(zero.json.error?.details?.['lines.0.quantity']).toEqual([`None left at ${MIRPUR}.`]);

  // Scan (§5.3): exact SKU, case-insensitive; LIKE wildcards are literal; > 64 chars → 422.
  const sku = (shop.variable.variants[1].sku as string).toLowerCase();
  const hit = await ok(await lookupRaw(shop.s, shop.register.id, sku), 200, 'lookup sku');
  expect(hit.variants.map((v: Json) => v.id)).toEqual([shop.kurtaL]);
  expect(hit.variants[0].available).toBe(2);
  for (const code of ['%', '_', 'QA-%', `${sku.slice(0, 5)}%`]) {
    const r = await lookupRaw(shop.s, shop.register.id, code);
    expect([code, r.status, r.json.error?.code]).toEqual([code, 404, 'pos_code_not_found']);
  }
  expect((await lookupRaw(shop.s, shop.register.id, 'X'.repeat(65))).status).toBe(422);
});

test('UI: out-of-stock tile, picker cap, stock gone during payment → inline error + Refresh cart; scan adds', async ({ page, context }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);

  // Wrap is at 0 in Mirpur → disabled "Out of stock" tile (Main still has 10: the till never sells it).
  await expect(tile(page, WRAP)).toContainText('Out of stock');
  await expect(tile(page, WRAP)).toBeDisabled();
  await expect(tile(page, KURTA)).toContainText(/\d+ in stock/);

  // Picker: M has 2 here → + stops at 2.
  await tile(page, KURTA).click();
  const picker = page.getByRole('dialog', { name: 'Choose options' });
  await picker.getByRole('button', { name: /^M/ }).click();
  await expect(picker.getByText('2 in this shop')).toBeVisible();
  await picker.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(picker.getByTestId('pos-picker-qty')).toHaveText('2');
  await expect(picker.getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
  await picker.getByTestId('pos-picker-add').click();
  await expect(cart(page).getByTestId('pos-line-qty')).toHaveText('2');
  expect(await chargeTotal(page)).toBe(240000);

  // Another till takes one M while this cashier is on the payment dialog.
  await cart(page).getByRole('radio', { name: 'Card' }).click();
  await cart(page).getByTestId('pos-charge').click();
  const pay = paymentDialog(page);
  await expect(pay).toBeVisible();
  await cashSale(shop.s, sess.id, [{ variant_id: shop.kurtaM, quantity: 1 }]);
  const refused = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect([refused.status, refused.body.error?.code]).toEqual([422, 'out_of_stock']);
  await expect(pay).toBeHidden();
  await expect(cart(page).getByTestId('pos-cart-notice')).toContainText('Some items are short at this shop');
  const line = cart(page).getByTestId('pos-cart-line').first();
  await expect(line.getByRole('alert')).toContainText(`Only 1 left at ${MIRPUR}.`);
  await expect(line.getByRole('button', { name: 'Refresh cart' })).toBeVisible();
  await expect(cart(page).getByTestId('pos-charge')).toBeDisabled();
  expect(await ordersWhere(shop.s, 'filter[created_via]=pos'), 'the refused sale wrote nothing').toHaveLength(2);

  // Fix the cart: − to 1 → charge again → 201.
  await line.getByRole('button', { name: `Decrease ${KURTA}` }).click();
  await expect(line.getByTestId('pos-line-qty')).toHaveText('1');
  await cart(page).getByTestId('pos-cart-notice').getByRole('button', { name: 'Refresh cart' }).click();
  expect(await chargeTotal(page)).toBe(120000);
  await cart(page).getByTestId('pos-charge').click();
  const sold = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(sold.status, JSON.stringify(sold.body).slice(0, 300)).toBe(201);
  await saleComplete(page).getByTestId('pos-new-sale').click();
  expect(await stockAt(shop.s, shop.kurtaM, shop.shop.id)).toMatchObject({ on_hand: 0 });
  expect(await stockAt(shop.s, shop.kurtaM, shop.main.id)).toMatchObject({ on_hand: 10 });

  // Scan: SKU + Enter adds Kurta L straight to the cart (no picker); an unknown code stays as a filter.
  const search = page.getByTestId('pos-search');
  await search.fill(shop.variable.variants[1].sku as string);
  const looked = page.waitForResponse((r) => /\/pos\/lookup\?/.test(r.url()));
  await search.press('Enter');
  expect((await looked).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: 'Choose options' })).toHaveCount(0);
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
  await expect(search).toHaveValue('');
  await search.fill('NO-SUCH-CODE-8D');
  await search.press('Enter');
  await expect(page.getByText('No products match — try another name or scan the barcode')).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S198: coupon priced by the server; a stale expected total → 409 checkout_changed (details.quote) → notice, re-charge', async ({ page, context }) => {
  test.setTimeout(150_000);
  const cp = await apiCall(shop.s, 'POST', `/stores/${shop.s.storeId}/coupons`, { json: { code: 'QA8D100', type: 'fixed', amount: 10000, status: 'active' } });
  expect(cp.status, cp.text.slice(0, 200)).toBe(201);
  const lines = [{ variant_id: shop.kurtaL, quantity: 1 }];
  const q = await quote(shop.s, sess.id, lines, { coupon_code: 'QA8D100' });
  expect(q).toMatchObject({ subtotal_amount: 140000, discount_amount: 10000, coupon_code: 'QA8D100', total_amount: 130000 });
  const bad = await quoteRaw(shop.s, { session_id: sess.id, lines, coupon_code: 'NOPE8D' });
  expect([bad.status, bad.json.error?.code]).toEqual([422, 'coupon_invalid']);
  const stale = await saleRaw(shop.s, { ...body(shop.kurtaL, 1, 140000), coupon_code: 'QA8D100' });
  expect([stale.status, stale.json.error?.code]).toEqual([409, 'checkout_changed']);
  expect(stale.json.error?.details?.quote).toMatchObject({ total_amount: 130000, discount_amount: 10000 });
  expect(stale.json.error?.details?.expected_total_amount?.[0]).toMatch(/৳/);

  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  const search = page.getByTestId('pos-search');
  await search.fill(shop.variable.variants[1].sku as string);
  await search.press('Enter');
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
  await cart(page).getByRole('button', { name: 'Add coupon' }).click();
  await cart(page).getByLabel('Coupon code').fill('nope8d');
  await cart(page).getByRole('button', { name: 'Apply' }).click();
  await expect(cart(page).getByRole('alert').filter({ hasText: /coupon|code/i }).first(), 'unknown coupon → inline error').toBeVisible();
  await cart(page).getByLabel('Coupon code').fill('qa8d100');
  await cart(page).getByRole('button', { name: 'Apply' }).click();
  await expect(cart(page).getByTestId('pos-totals')).toContainText('Discount · QA8D100');
  await expect(cart(page).getByTestId('pos-totals')).toContainText('− ৳ 100');
  expect(await chargeTotal(page)).toBe(130000);

  // The price moved between quote and Complete (simulated: the till sends the old total once) → 409 → notice.
  let rewrite = true;
  await page.route(/\/pos\/sales$/, async (route) => {
    if (!rewrite || route.request().method() !== 'POST') return route.continue();
    rewrite = false;
    const b = JSON.parse(route.request().postData() ?? '{}');
    return route.continue({ postData: JSON.stringify({ ...b, expected_total_amount: 140000 }) });
  });
  await cart(page).getByRole('radio', { name: 'Card' }).click();
  await cart(page).getByTestId('pos-charge').click();
  const pay = paymentDialog(page);
  await expect(pay.getByTestId('pos-amount-to-pay')).toHaveText('৳ 1,300');
  const r409 = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect([r409.status, r409.body.error?.code]).toEqual([409, 'checkout_changed']);
  await expect(pay).toBeHidden();
  await expect(cart(page).getByTestId('pos-cart-notice')).toContainText('Prices or the coupon changed');
  expect(await chargeTotal(page)).toBe(130000);
  await cart(page).getByTestId('pos-charge').click();
  const okSale = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(okSale.status, JSON.stringify(okSale.body).slice(0, 300)).toBe(201);
  expect(okSale.body.data.receipt).toMatchObject({ discount_amount: 10000, coupon_code: 'QA8D100', total_amount: 130000 });
  await expect(page.getByTestId('pos-receipt').filter({ visible: true }).first()).toContainText('QA8D100');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

// Last on purpose (serial file): it fails until P88DA-QA-2 is fixed and must not skip the tests above.
test('P88DA-QA-2: a scanned variant keeps its options in the cart line ("{options} · ৳ price", §11.2)', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  const search = page.getByTestId('pos-search');
  await search.fill(shop.variable.variants[1].sku as string);
  await search.press('Enter');
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
  await expect(cart(page).getByTestId('pos-cart-line'), 'scanned Kurta L shows "L · ৳ 1,400" like a picked one').toContainText('L · ৳ 1,400');
});
