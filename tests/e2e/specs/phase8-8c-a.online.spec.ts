import { expect, test, type Page } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { browserHost, inventoryOf, orderIdByNumber, placeOrder, transition, type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import {
  addLocationButton,
  chooseOption,
  DEFAULT_NAME,
  defaultLocation,
  DHANMONDI,
  locationByName,
  locationCard,
  locationMenu,
  locations,
  locationSelector,
  movementsWhere,
  mUrl,
  ONLINE_NOTE,
  openWarehouses,
  sfAvailability,
  sfCanAdd,
  stockAt,
  stockRow,
} from '../support/locations';
import { purchasingShop, shipOrder, waitApi } from '../support/purchasing';

/**
 * PHASE-8-8C §13 QA part A (b) + (c), AC 2 (P88C-2/3/4/5/7, §5.2, §5.3, S183, S184), Growth shop, stock 4 per variant
 * (simple "QA Muslin Wrap", low-stock threshold 5, so the storefront shows the exact online count as `low_stock`):
 *  (b) Warehouses "+ Add location" → "Dhanmondi shop" (shop) → Inventory adjust dialog, Location = Dhanmondi, +3 →
 *      Dhanmondi 3 / Main 4 / total 7; storefront (API + PDP "Only 4 left") sees only Main; a cart of 5 is refused.
 *  (c) two storefront orders (A, B: 1 each) commit at Main → online available 2 → row menu "Make default" on Dhanmondi
 *      (Default + "Online orders ship from here" move) → storefront shows 3 (PDP "Only 3 left"), a cart of 4 is refused;
 *      ship A and cancel B after the switch → Main 3 on hand / 0 committed, Dhanmondi untouched (S184); the shipped
 *      movement is at Main; a new order C commits at Dhanmondi; product `inventory` block = online row + totals.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let main: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let dhan: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let orderA = '';
let orderB = '';
const sv = () => shop.simple.variantId;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('lon', 'growth', 4);
  browserHost(shop);
  main = await defaultLocation(shop.s);
});
test.afterAll(() => shop?.cleanup());

async function pdpLowStock(page: Page, n: number) {
  await page.goto(`${shop.storefront}/products/${shop.simple.slug}`);
  await expect(page.getByRole('heading', { name: 'QA Muslin Wrap' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(new RegExp(`Only ${n} left`)).first()).toBeVisible({ timeout: 15_000 });
}

test('(b) Warehouses: "+ Add location" creates "Dhanmondi shop" (P88C-2)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openWarehouses(page);
  await expect(locationCard(page, DEFAULT_NAME)).toBeVisible();
  await addLocationButton(page).click();
  const d = page.getByRole('dialog').last();
  await expect(d).toBeVisible();
  await d.getByLabel(/^Name/i).first().fill(DHANMONDI);
  const type = d.getByLabel(/^Type/i).or(d.getByRole('radio', { name: /^Shop$/i })).first();
  if (await type.isVisible().catch(() => false)) {
    if ((await type.getAttribute('type')) === 'radio') await type.check();
    else await chooseOption(d, page, /^Type/i, 'Shop');
  }
  await d.getByLabel(/^Address/i).first().fill('Road 27, Dhanmondi, Dhaka').catch(() => undefined);
  const saved = waitApi(page, 'POST', /\/locations$/);
  await d.getByRole('button', { name: /^(Add location|Save location|Save|Add)$/ }).last().click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  await expect(d).toBeHidden();
  await expect(locationCard(page, DHANMONDI)).toBeVisible();

  dhan = await locationByName(shop.s, DHANMONDI);
  expect(dhan).toMatchObject({ type: 'shop', is_default: false, units_on_hand: 0 });
  expect((await locations(shop.s)).map((l) => l.name)).toEqual([DEFAULT_NAME, DHANMONDI]); // default first
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(b) Inventory: adjust +3 at Dhanmondi through the Location select (§10.1)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/inventory'));
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 20_000 });
  await expect(locationSelector(page), 'location selector with 2 locations').toBeVisible();

  const row = page.getByRole('row').filter({ hasText: 'QA Muslin Wrap' }).or(page.getByRole('listitem').filter({ hasText: 'QA Muslin Wrap' })).first();
  await row.getByRole('button', { name: /Adjust/i }).first().click();
  const d = page.getByRole('dialog').last();
  await expect(d).toBeVisible();
  await chooseOption(d, page, /^Location/i, DHANMONDI);
  await expect(d.getByText(new RegExp(`on hand at ${DHANMONDI}`)).first()).toBeVisible();
  const reason = d.getByLabel(/^Reason/i).first();
  if (await reason.isVisible().catch(() => false)) await chooseOption(d, page, /^Reason/i, 'Received').catch(() => undefined);
  // "+ Add" segment (the dialog opens in "Set to" for a correction)
  await d.getByRole('radio', { name: '+ Add' }).or(d.getByRole('button', { name: '+ Add' })).or(d.getByRole('tab', { name: '+ Add' })).first().click();
  await d.getByLabel(/^Quantity/).first().fill('3');
  const saved = waitApi(page, 'POST', /\/inventory\/adjustments$/);
  await d.getByRole('button', { name: /^(Save|Adjust|Update stock|Save adjustment|Apply)/ }).last().click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(200);
  const sent = res.request().postDataJSON() as { items: Array<{ location_id?: string; quantity: number; mode: string }> };
  expect(sent.items[0], 'adjust names the chosen location').toMatchObject({ location_id: dhan.id, mode: 'delta', quantity: 3 });

  expect(await stockAt(shop.s, sv(), dhan.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });
  expect(await stockAt(shop.s, sv(), main.id)).toEqual({ on_hand: 4, committed: 0, available: 4 });
  const all = await stockRow(shop.s, sv());
  expect(all).toMatchObject({ on_hand: 7, committed: 0, available: 7 });
  expect(all!.locations).toEqual(expect.arrayContaining([expect.objectContaining({ id: main.id, on_hand: 4 }), expect.objectContaining({ id: dhan.id, on_hand: 3 })]));
  const mv = await movementsWhere(shop.s, { location_id: dhan.id });
  expect(mv.map((m) => [m.delta, m.location?.name])).toEqual([[3, DHANMONDI]]);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(b) storefront sees only the online location: API, cart and PDP (S183)', async ({ page }) => {
  test.setTimeout(60_000);
  expect(await sfAvailability(shop, shop.simple.slug, sv())).toEqual({ available: true, low_stock: 4 });
  expect(await sfCanAdd(shop, sv(), 5)).toEqual({ ok: false, code: 'out_of_stock' });
  expect((await sfCanAdd(shop, sv(), 4)).ok).toBe(true);
  await pdpLowStock(page, 4);
});

test('(c) orders A and B commit at the online location (Main)', async () => {
  test.setTimeout(90_000);
  const a = await placeOrder(shop, sv(), 1);
  const b = await placeOrder(shop, sv(), 1);
  orderA = await orderIdByNumber(shop.s, a.order.number);
  orderB = await orderIdByNumber(shop.s, b.order.number);
  expect(await stockAt(shop.s, sv(), main.id)).toEqual({ on_hand: 4, committed: 2, available: 2 });
  expect(await stockAt(shop.s, sv(), dhan.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });
  expect((await sfAvailability(shop, shop.simple.slug, sv())).low_stock).toBe(2);
});

test('(c) Warehouses "Make default" moves online selling to Dhanmondi (P88C-5)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openWarehouses(page);
  const saved = waitApi(page, 'POST', /\/locations\/[0-9A-Za-z]{26}\/make-default$/);
  await locationMenu(page, DHANMONDI, /Make default/i);
  const confirm = page.getByRole('dialog').last().getByRole('button', { name: /Make default|Confirm|Yes/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(200);
  await expect(locationCard(page, DHANMONDI).getByText(ONLINE_NOTE)).toBeVisible();
  await expect(locationCard(page, DEFAULT_NAME).getByText(ONLINE_NOTE)).toHaveCount(0);
  expect((await defaultLocation(shop.s)).id).toBe(dhan.id);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(c) storefront availability switches immediately to Dhanmondi (S183)', async ({ page }) => {
  test.setTimeout(60_000);
  expect(await sfAvailability(shop, shop.simple.slug, sv())).toEqual({ available: true, low_stock: 3 });
  expect(await sfCanAdd(shop, sv(), 4)).toEqual({ ok: false, code: 'out_of_stock' });
  await pdpLowStock(page, 3);
  const inv = await inventoryOf(shop.s, shop.simple.id, sv());
  expect(inv).toMatchObject({ location_id: dhan.id, on_hand: 3, committed: 0, available: 3, total_on_hand: 7, other_locations_on_hand: 4 });
});

test('(c) A ships and B cancels against Main after the switch; Dhanmondi untouched (S184)', async () => {
  test.setTimeout(90_000);
  await shipOrder(shop.s, orderA);
  expect(await stockAt(shop.s, sv(), main.id)).toEqual({ on_hand: 3, committed: 1, available: 2 });
  const cancel = await transition(shop.s, orderB, 'cancel', { reason: 'customer_request', notify_customer: false });
  expect(cancel.status, JSON.stringify(cancel.json).slice(0, 300)).toBe(200);
  expect(await stockAt(shop.s, sv(), main.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });
  expect(await stockAt(shop.s, sv(), dhan.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });

  const shipped = (await movementsWhere(shop.s, { reason: 'order_shipped' })).filter((m) => m.variant_id === sv() || m.variant?.id === sv());
  expect(shipped.map((m) => [m.delta, m.location?.id])).toEqual([[-1, main.id]]);

  // A new order after the switch commits at Dhanmondi.
  await placeOrder(shop, sv(), 1);
  expect(await stockAt(shop.s, sv(), dhan.id)).toEqual({ on_hand: 3, committed: 1, available: 2 });
  expect(await stockAt(shop.s, sv(), main.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });
  expect((await sfAvailability(shop, shop.simple.slug, sv())).low_stock).toBe(2);
});
