import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import {
  adjust,
  createLocationRaw,
  DEFAULT_NAME,
  locationCard,
  locations,
  locationSelector,
  movementsWhere,
  mUrl,
  ONLINE_NOTE,
  openWarehouses,
  sfAvailability,
  stockRow,
  UPGRADE_NOTE,
} from '../support/locations';
import { createPo, createSupplier, inventoryRow, lineFor, purchasingShop, receive, sendPo } from '../support/purchasing';

/**
 * PHASE-8-8C §13 QA part A (a) + AC 1 / S182 / S181: a one-location store behaves exactly as before part A.
 * Starter shop (stock 4 per variant, created after the backfill → store creation made the default row):
 *  - exactly one location "Main warehouse", default (= online), carrying the shop's whole stock;
 *  - adjust / PO / receive without any `location_id` land on it (8.8b smoke: PO → send → receive → stock up);
 *  - storefront availability unchanged; a 2nd location → 402 `feature_not_in_plan` (Starter has no `multi_warehouse`);
 *  - UI: Inventory shows no location selector, no "Receive at", no Transfer stock / Stock count (part B); the Adjust
 *    dialog has no Location field; the Warehouses tab lists the one location with "Online orders ship from here" and the
 *    upgrade note.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const sv = () => shop.simple.variantId;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('l1', 'starter', 4);
});
test.afterAll(() => shop?.cleanup());

test('one default location "Main warehouse" holds all stock; Starter cannot add a second (S181, S182)', async () => {
  const list = await locations(shop.s);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: DEFAULT_NAME, type: 'warehouse', is_default: true, archived_at: null });
  expect(list[0].units_on_hand).toBe(4 + 4 + 4); // wrap 4 + kurta M 4 + kurta L 4

  const second = await createLocationRaw(shop.s, { name: 'Dhanmondi shop', type: 'shop' });
  expect([second.status, second.json.error?.code], second.text.slice(0, 200)).toEqual([402, 'feature_not_in_plan']);
  expect(await locations(shop.s)).toHaveLength(1);
});

test('adjust, inventory and storefront are unchanged without a location_id (AC 1)', async () => {
  const main = (await locations(shop.s))[0];
  const res = await adjust(shop.s, [{ variant_id: sv(), quantity: 1 }]);
  expect(res.items[0]).toMatchObject({ variant_id: sv(), on_hand: 5, committed: 0, available: 5 });
  const mv = await movementsWhere(shop.s, { reason: 'received' });
  expect(mv[0].location, 'movement carries the default location').toMatchObject({ id: main.id, name: DEFAULT_NAME });

  // All-locations row = the one location's numbers.
  const row = await stockRow(shop.s, sv());
  expect(row).toMatchObject({ on_hand: 5, committed: 0, available: 5 });
  if (row!.locations) expect(row!.locations).toEqual([expect.objectContaining({ id: main.id, on_hand: 5, committed: 0, available: 5 })]);

  // simple: threshold 5 → low_stock 5 on the storefront
  expect(await sfAvailability(shop, shop.simple.slug, sv())).toEqual({ available: true, low_stock: 5 });
});

test('8.8b smoke: PO without location_id is received at the default location', async () => {
  const main = (await locations(shop.s))[0];
  const sup = await createSupplier(shop.s);
  const draft = await createPo(shop.s, sup.id, [{ variant_id: sv(), unit_cost_amount: 25_000, quantity: 3 }]);
  expect(draft.location_id ?? draft.location?.id, 'PO defaults to the default location (P88C-8)').toBe(main.id);
  const ordered = await sendPo(shop.s, draft.id, 'manual');
  await receive(shop.s, ordered.id, [{ item_id: lineFor(ordered, sv()).id, received: 3 }]);
  expect((await inventoryRow(shop.s, sv())).on_hand).toBe(8);
  expect((await locations(shop.s))[0].units_on_hand).toBe(8 + 4 + 4);
});

test('UI: no location UI on Inventory; Warehouses tab shows the one location + upgrade note', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/inventory'));
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  await expect(locationSelector(page), 'no location selector with one location').toHaveCount(0);
  await expect(page.getByText(/All locations/)).toHaveCount(0);
  for (const hidden of [/Transfer stock/i, /Receive at/i]) await expect(page.getByText(hidden), `${hidden}`).toHaveCount(0);

  // Adjust dialog: no Location field.
  const row = page.getByRole('row').filter({ hasText: 'QA Muslin Wrap' }).or(page.getByRole('listitem').filter({ hasText: 'QA Muslin Wrap' })).first();
  const adjustBtn = row.getByRole('button', { name: /Adjust/i }).first();
  if (await adjustBtn.isVisible().catch(() => false)) {
    await adjustBtn.click();
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible();
    await expect(d.getByLabel(/^Location$/)).toHaveCount(0);
    await page.keyboard.press('Escape');
  } else {
    test.info().annotations.push({ type: 'note', description: 'no per-row Adjust button found; adjust dialog not checked' });
  }

  await openWarehouses(page);
  const card = locationCard(page, DEFAULT_NAME);
  await expect(card).toBeVisible();
  await expect(card.getByText(ONLINE_NOTE).or(page.getByText(ONLINE_NOTE)).first()).toBeVisible();
  await expect(page.getByText(UPGRADE_NOTE).first(), 'upgrade note on Starter').toBeVisible();
  await expect(page.getByText(/Dhanmondi/)).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
