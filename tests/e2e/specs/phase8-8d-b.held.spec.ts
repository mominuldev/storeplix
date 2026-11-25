import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { randomPhone } from '../support/commerce';
import { stockAt } from '../support/locations';
import { watchConsole } from '../support/roles';
import {
  cart,
  cashSale,
  chargeTotal,
  closeRaw,
  createRegisterRaw,
  gotoPos,
  heldDeleteRaw,
  heldGetRaw,
  heldList,
  heldListRaw,
  holdRaw,
  ok,
  openSession,
  paymentDialog,
  posShop,
  saleComplete,
  saleRaw,
  saleResponse,
  session,
  stubPrint,
  tile,
  WRAP,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part B held sales (§9, §11.6, P88D-16, S207; §16 AC 7), real stack:
 *  - UI: build a cart (customer by phone + note) → Hold sale → cart empties, "Held · 1" → Held sales drawer card
 *    (customer, "{phone} · n items", total, "Held … · “note”") → Resume → cart, customer and lines back → Charge sends
 *    `held_sale_id` → the held sale is gone (drawer "No held sales", GET 404).
 *  - Held sales don't reserve stock (copy shown; another till sells the units; resuming shows the line short).
 *  - Limit: 20 per register → 21st 409 `held_sales_limit` (API) and the hold dialog message (UI).
 *  - `held_sale_id` of another register / already completed / unknown → 422 on that field.
 *  - Close warns "n held sales will be deleted" and deletes them.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sess: Json;
let reg2: Json;
let sess2: Json;
const phone = randomPhone();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('phld', 'growth', { online: 10, atShop: 5 });
  sess = await openSession(shop.s, shop.register.id, { opening_cash_amount: 100000 });
  reg2 = await ok(await createRegisterRaw(shop.s, { name: 'Register 2', location_id: shop.shop.id }), 201, 'register 2');
  sess2 = await openSession(shop.s, reg2.id, { opening_cash_amount: 0 });
});
test.afterAll(() => shop?.cleanup());

test('UI: hold with customer + note → drawer card → resume → sell; the held sale is gone', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  await expect(page.getByTestId('pos-hold-sale'), 'Hold sale needs a cart').toBeDisabled();
  await expect(page.getByTestId('pos-held-open')).toHaveText('Held · 0');

  await tile(page, WRAP).click();
  await tile(page, WRAP).click();
  await cart(page).getByRole('button', { name: 'Add customer' }).click();
  await cart(page).getByLabel('Customer phone').fill(phone);
  await cart(page).getByLabel('New customer name').fill('QA Held Buyer');
  expect(await chargeTotal(page)).toBe(100000);
  await page.getByTestId('pos-hold-sale').click();
  const dlg = page.getByRole('dialog', { name: 'Hold sale' });
  await expect(dlg).toContainText('Held sales don’t hold stock. Items are checked again when you resume.');
  await dlg.getByTestId('pos-hold-note').fill('Trying another size');
  const held = page.waitForResponse((r) => r.request().method() === 'POST' && /\/pos\/held-sales$/.test(new URL(r.url()).pathname));
  await dlg.getByTestId('pos-hold-confirm').click();
  const hr = await held;
  expect(hr.status(), await hr.text()).toBe(201);
  const heldSale = (await hr.json()).data as Json;
  expect(heldSale).toMatchObject({ customer_name: 'QA Held Buyer', customer_phone: `88${phone}`, note: 'Trying another size', items_count: 2, total_amount: 100000 });
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(0);
  await expect(page.getByTestId('pos-held-open')).toHaveText('Held · 1');
  // No stock reserved (Q242): Mirpur still 5.
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 5, available: 5 });

  await page.getByTestId('pos-held-open').click();
  const drawer = page.getByTestId('pos-held-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('pos-held-note')).toHaveText('Held sales don’t hold stock. Items are checked again when you resume.');
  const card = drawer.getByTestId('pos-held-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('QA Held Buyer');
  await expect(card).toContainText('2 items');
  await expect(card).toContainText('৳ 1,000');
  await expect(card).toContainText('“Trying another size”');
  await drawer.getByLabel('Search by customer or note').fill('nothing-like-this');
  await expect(drawer.getByTestId('pos-held-empty')).toHaveText('No held sales match.');
  await drawer.getByLabel('Search by customer or note').fill('another size');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Resume' }).click();
  await expect(drawer).toBeHidden();
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
  await expect(cart(page).getByTestId('pos-cart-line')).toContainText(WRAP);
  await expect(cart(page).getByTestId('pos-line-qty')).toHaveText('2');
  // A new phone at hold time is still a new customer on resume: phone and name come back into the boxes.
  await expect(cart(page).getByLabel('Customer phone')).toHaveValue(/^01\d{3}-?\d{6}$/);
  await expect(cart(page).getByLabel('New customer name')).toHaveValue('QA Held Buyer');
  expect(await chargeTotal(page)).toBe(100000);

  await cart(page).getByRole('radio', { name: 'Card' }).click();
  await cart(page).getByTestId('pos-charge').click();
  const sale = await saleResponse(page, () => paymentDialog(page).getByTestId('pos-complete-sale').click());
  expect(sale.status, JSON.stringify(sale.body).slice(0, 300)).toBe(201);
  await saleComplete(page).getByTestId('pos-new-sale').click();
  // The completing sale deleted the held one.
  expect((await heldGetRaw(shop.s, heldSale.id)).status).toBe(404);
  expect(await heldList(shop.s, shop.register.id)).toHaveLength(0);
  await expect(page.getByTestId('pos-held-open')).toHaveText('Held · 0');
  await page.getByTestId('pos-held-open').click();
  await page.getByLabel('Search by customer or note').fill('');
  await expect(page.getByTestId('pos-held-empty')).toHaveText('No held sales');
  await page.keyboard.press('Escape');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('held sales reserve no stock: sold elsewhere → resumed line is short', async ({ page, context }) => {
  test.setTimeout(120_000);
  // Mirpur wrap is 3 now. Hold 3, sell 3 on Register 2, resume on Register 1.
  const h = await holdRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.wrap, quantity: 3 }], note: 'All three' });
  expect(h.status, h.text.slice(0, 200)).toBe(201);
  await cashSale(shop.s, sess2.id, [{ variant_id: shop.wrap, quantity: 3 }]);
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 0 });

  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  await page.getByTestId('pos-held-open').click();
  await page.getByTestId('pos-held-card').filter({ hasText: 'All three' }).getByRole('button', { name: 'Resume' }).click();
  await expect(cart(page).getByTestId('pos-cart-line')).toHaveCount(1);
  await expect(cart(page).getByTestId('pos-cart-line').getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(cart(page).getByTestId('pos-charge')).toBeDisabled();
  // The API refuses a sale for it too.
  const r = await saleRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.wrap, quantity: 3 }], expected_total_amount: 150000, payments: [{ method: 'card', amount: 150000 }], sms_receipt: false, held_sale_id: h.json.data.id });
  expect([r.status, r.json.error?.code]).toEqual([422, 'out_of_stock']);
  expect((await heldGetRaw(shop.s, h.json.data.id)).status, 'a refused sale keeps the held sale').toBe(200);
  expect((await heldDeleteRaw(shop.s, h.json.data.id)).status).toBeLessThan(300);
});

test('held_sale_id rules: other register / completed / unknown → 422; limit 20 → 409 held_sales_limit (API + UI)', async ({ page, context }) => {
  test.setTimeout(180_000);
  const body = (sid: string, held: string) => ({ session_id: sid, lines: [{ variant_id: shop.kurtaL, quantity: 1 }], expected_total_amount: 140000, payments: [{ method: 'card', amount: 140000 }], sms_receipt: false, held_sale_id: held });
  const other = await holdRaw(shop.s, { session_id: sess2.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }] });
  expect(other.status).toBe(201);
  const cross = await saleRaw(shop.s, body(sess.id, other.json.data.id));
  expect([cross.status, cross.json.error?.code, Object.keys(cross.json.error?.details ?? {})]).toEqual([422, 'validation_failed', ['held_sale_id']]);
  const unknown = await saleRaw(shop.s, body(sess.id, '01ARZ3NDEKTSV4RRFFQ69G5FAV'));
  expect([unknown.status, Object.keys(unknown.json.error?.details ?? {})]).toEqual([422, ['held_sale_id']]);
  const done = await saleRaw(shop.s, body(sess2.id, other.json.data.id));
  expect(done.status, done.text.slice(0, 200)).toBe(201);
  const again = await saleRaw(shop.s, body(sess2.id, other.json.data.id));
  expect([again.status, Object.keys(again.json.error?.details ?? {})], 'completed held sale can’t be used twice').toEqual([422, ['held_sale_id']]);

  // Limit: fill Register 1 to 20.
  const have = (await heldList(shop.s, shop.register.id)).length;
  for (let i = have; i < 20; i++) {
    const r = await holdRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.kurtaM, quantity: 1 }], note: `Park ${i + 1}` });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
  }
  const over = await holdRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.kurtaM, quantity: 1 }] });
  expect([over.status, over.json.error?.code]).toEqual([409, 'held_sales_limit']);

  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}`);
  await expect(page.getByTestId('pos-held-open')).toHaveText('Held · 20');
  await tile(page, 'QA Cotton Kurta').click();
  await page.getByRole('dialog', { name: 'Choose options' }).getByTestId('pos-picker-add').click();
  await page.getByTestId('pos-hold-sale').click();
  const dlg = page.getByRole('dialog', { name: 'Hold sale' });
  await dlg.getByTestId('pos-hold-confirm').click();
  await expect(dlg.getByRole('alert')).toHaveText('This register already has 20 held sales. Resume or delete one first.');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  // Delete one from the drawer → 19.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('pos-held-open').click();
  await page.getByTestId('pos-held-card').filter({ hasText: 'Park 20' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('pos-held-card')).toHaveCount(19);
  expect(await heldList(shop.s, shop.register.id)).toHaveLength(19);
});

test('close warns about held sales and deletes them', async ({ page, context }) => {
  test.setTimeout(120_000);
  const s = await session(shop.s, sess.id);
  expect(s.totals.held_sales_count).toBe(19);
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sess.id}/close`);
  await expect(page.getByRole('alert').filter({ hasText: '19 held sales will be deleted' })).toBeVisible();
  const r = await closeRaw(shop.s, sess.id, { counted_cash_amount: s.totals.cash_in_drawer_amount, left_in_drawer_amount: 0, revision: s.revision });
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  expect((await heldListRaw(shop.s, shop.register.id)).json.data).toEqual([]);
  // Register 2 keeps its own (none left after its sale) — closing one register never touches another's.
  const hold2 = await holdRaw(shop.s, { session_id: sess2.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }] });
  expect(hold2.status).toBe(201);
  expect(await heldList(shop.s, reg2.id)).toHaveLength(1);
  // Holding on a closed session → 409 register_closed.
  const closedHold = await holdRaw(shop.s, { session_id: sess.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }] });
  expect([closedHold.status, closedHold.json.error?.code]).toEqual([409, 'register_closed']);
});
