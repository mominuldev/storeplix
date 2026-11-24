import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { pageOverflow, watchConsole } from '../support/roles';
import { createLocation, defaultLocation, DEFAULT_NAME, DHANMONDI, stockAt } from '../support/locations';
import {
  createPo,
  createSupplier,
  lineFor,
  mUrl,
  NEW_PO,
  openPo,
  patchPoRaw,
  po,
  poMovements,
  purchasingShop,
  quickRaw,
  receive,
  receiveInputs,
  receiveUnits,
  sendPo,
  variantOf,
  waitApi,
  weightedCost,
} from '../support/purchasing';

/**
 * PHASE-8-8C §13 QA part A (d), §6, §10.3, P88C-8, S186 — "Receive at" on purchase orders, Growth shop with
 * "Main warehouse" (default, kurta L on hand 4 @ ৳ 800) + "Dhanmondi shop" (empty):
 *  - New purchase order shows a "Receive at" field (> 1 location) listing both locations;
 *  - PO for 5 × kurta L @ ৳ 600 with `location_id` = Dhanmondi → send → PO page says "Receive at Dhanmondi shop" →
 *    UI receive 2 ("Receive 2 units") → stock lands at Dhanmondi only; changing the location now → 422
 *    `location_locked`; receive the other 3 → Dhanmondi 5, Main still 4; the PO's ledger rows are at Dhanmondi;
 *  - weighted-average cost uses the TOTAL on hand across locations (S186): 4 @ 800 + 2 @ 600 → 733.33 → 3 @ 600;
 *  - quick purchase with `location_id` stocks that location.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let main: Json;
let dhan: Json;
let sup: Json;
let ordered: Json;
const lv = () => shop.variable.variants[1].id as string; // kurta L, cost ৳ 800
const COST_1 = weightedCost(4, 80_000, 2, 60_000);
const COST_2 = weightedCost(6, COST_1, 3, 60_000);

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('lra', 'growth', 4);
  main = await defaultLocation(shop.s);
  dhan = await createLocation(shop.s, DHANMONDI);
  sup = await createSupplier(shop.s, { name: `QA Karim Traders ${Date.now().toString(36).slice(-4)}` });
});
test.afterAll(() => shop?.cleanup());

test('cost helper vectors (S186: weighted average over total on hand)', () => {
  expect(COST_1).toBe(73_333); // (4 × 80 000 + 2 × 60 000) / 6
  expect(COST_2).toBe(68_889); // (6 × 73 333 + 3 × 60 000) / 9
  expect(weightedCost(0, 80_000, 2, 60_000), 'location-only maths would give the landed cost').toBe(60_000);
});

test('New purchase order offers "Receive at" with both locations (§10.3)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(NEW_PO));
  await expect(page.getByRole('heading', { name: /New purchase order/, level: 1 })).toBeVisible({ timeout: 20_000 });
  const field = page.getByLabel(/Receive at/i).or(page.getByRole('combobox', { name: /Receive at/i })).first();
  await expect(field).toBeVisible();
  if ((await field.evaluate((el) => el.tagName.toLowerCase())) === 'select') {
    const opts = (await field.locator('option').allTextContents()).join(' | ');
    expect(opts).toContain(DEFAULT_NAME);
    expect(opts).toContain(DHANMONDI);
  } else {
    await field.click();
    await expect(page.getByRole('option', { name: new RegExp(DHANMONDI) })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('PO with Receive at Dhanmondi: UI receive 2 → stock lands at Dhanmondi; location locked (P88C-8)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const draft = await createPo(shop.s, sup.id, [{ variant_id: lv(), unit_cost_amount: 60_000, quantity: 5 }], { location_id: dhan.id });
  expect(draft.location_id ?? draft.location?.id).toBe(dhan.id);
  // editable while there are no receipts
  const back = await patchPoRaw(shop.s, draft.id, { location_id: main.id, revision: draft.revision });
  expect(back.status, back.text.slice(0, 300)).toBe(200);
  const again = await patchPoRaw(shop.s, draft.id, { location_id: dhan.id, revision: back.json.data.revision });
  expect(again.status, again.text.slice(0, 300)).toBe(200);
  ordered = await sendPo(shop.s, draft.id, 'manual');

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openPo(page, ordered.id, ordered.number);
  await expect(page.getByText(new RegExp(`Receive at\\s*:?\\s*${DHANMONDI}`, 'i')).first(), 'Receive subtitle `36:6615`').toBeVisible();
  await receiveInputs(page, 'QA Cotton Kurta').now.fill('2');
  await expect(page.getByText(new RegExp(`Adding 2 units to ${DHANMONDI}`)).first(), 'footer `36:7118`').toBeVisible();
  const saved = waitApi(page, 'POST', /\/purchase-orders\/[0-9A-Za-z]{26}\/receipts$/);
  await receiveUnits(page).click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  expect(await pageOverflow(page)).toBeNull();
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  expect(await stockAt(shop.s, lv(), dhan.id)).toMatchObject({ on_hand: 2 });
  expect(await stockAt(shop.s, lv(), main.id)).toMatchObject({ on_hand: 4 });
  expect((await variantOf(shop.s, shop.variable.id, lv())).cost_amount).toBe(COST_1);

  const cur = await po(shop.s, ordered.id);
  const locked = await patchPoRaw(shop.s, ordered.id, { location_id: main.id, revision: cur.revision });
  expect([locked.status, locked.json.error?.code], locked.text.slice(0, 300)).toEqual([422, 'location_locked']);
});

test('receive the rest → Dhanmondi 5, Main 4; ledger rows at Dhanmondi; cost over total stock (S186)', async () => {
  const cur = await po(shop.s, ordered.id);
  await receive(shop.s, ordered.id, [{ item_id: lineFor(cur, lv()).id, received: 3 }]);
  expect(await stockAt(shop.s, lv(), dhan.id)).toMatchObject({ on_hand: 5, committed: 0, available: 5 });
  expect(await stockAt(shop.s, lv(), main.id)).toMatchObject({ on_hand: 4 });
  expect((await variantOf(shop.s, shop.variable.id, lv())).cost_amount).toBe(COST_2);
  const mv = await poMovements(shop.s, ordered.id);
  expect(mv.map((m) => [m.delta, m.location?.id])).toEqual(expect.arrayContaining([[2, dhan.id], [3, dhan.id]]));
  expect(mv).toHaveLength(2);
  const detail = await po(shop.s, ordered.id);
  for (const r of detail.receipts as Json[]) expect(r.location_id ?? r.location?.id, 'receipt records its location').toBe(dhan.id);
});

test('quick purchase with location_id stocks that location (§6)', async () => {
  const before = await stockAt(shop.s, shop.simple.variantId, dhan.id);
  const r = await quickRaw(shop.s, {
    supplier_id: sup.id,
    location_id: dhan.id,
    lines: [{ variant_id: shop.simple.variantId, unit_cost_amount: 20_000, quantity: 2, damaged: 0 }],
    shipping_amount: 0,
    discount_amount: 0,
  });
  expect(r.status, r.text.slice(0, 400)).toBe(201);
  expect(await stockAt(shop.s, shop.simple.variantId, dhan.id)).toMatchObject({ on_hand: before.on_hand + 2 });
  expect(await stockAt(shop.s, shop.simple.variantId, main.id)).toMatchObject({ on_hand: 4 });
});
