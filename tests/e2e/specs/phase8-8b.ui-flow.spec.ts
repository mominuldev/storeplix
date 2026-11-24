import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { pageOverflow, watchConsole } from '../support/roles';
import {
  addSupplierButton,
  button,
  dialog,
  inventoryTab,
  lineFor,
  MOVEMENTS,
  mUrl,
  NEW_PO,
  openPo,
  openSuppliers,
  pickInDialog,
  po,
  poList,
  purchasingShop,
  receiveAllRemaining,
  receiveInputs,
  receiveUnits,
  recordPayment,
  sendToSupplier,
  statusPill,
  suppliers,
  variantOf,
  waitApi,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA main flow in the merchant dashboard (§10.2–§10.4; Figma 153:35999, 35:6210, 36:6607), owner on Growth:
 *  "+ Add supplier" (composed form dialog) → New purchase order: supplier picked, two lines from "+ Add product",
 *  quantities / unit costs typed in taka, Transport + Supplier discount, info note "Stock value goes up by … Cost prices
 *  update automatically." → "Send to supplier" → PDF (WhatsApp offered, Email hidden) → the PO is ordered with
 *  sent_via `pdf` → Receive: 4 now + 1 damaged on the wrap, 2 on the kurta; footer "Adding 6 units to stock" and
 *  "1 damaged, not added to stock" → "Receive 6 units" (Idempotency-Key header sent) → Partly received → Stock movements
 *  show "Received · PO-n" → "Record payment" ৳ 1,000 → "Receive all remaining" → "Receive 8 units" → Received.
 * The numbers behind each step are asserted through the API (the exact maths are in phase8-8b.flow).
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const SUPPLIER = `QA Nadia Fabrics ${Date.now().toString(36).slice(-4)}`;
let supplierId = '';
let poId = '';
let number = '';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('pou', 'growth', 10);
});
test.afterAll(() => shop?.cleanup());

test('Suppliers: "+ Add supplier" saves a supplier and the row opens the detail panel', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSuppliers(page);
  await addSupplierButton(page).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByLabel(/^(Supplier )?name/i).first().fill(SUPPLIER);
  await d.getByLabel(/^Contact( name| person)?/i).first().fill('Nadia Akter').catch(() => undefined);
  await d.getByLabel(/^Phone/i).first().fill('01811000222');
  await d.getByLabel(/^City/i).first().fill('Narayanganj').catch(() => undefined);
  await d.getByLabel(/Lead time/i).first().fill('5').catch(() => undefined);
  const saved = waitApi(page, 'POST', /\/suppliers$/);
  await d.getByRole('button', { name: /^(Add supplier|Save supplier|Save)$/ }).last().click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  supplierId = (await res.json()).data.id;
  await expect(d).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: SUPPLIER }).or(page.getByRole('listitem').filter({ hasText: SUPPLIER })).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText('Nadia Akter').first()).toBeVisible();
  await expect(button(page, /New PO|New purchase order/)).toBeVisible();
  expect((await suppliers(shop.s, SUPPLIER)).data.map((x) => x.phone)).toEqual(['8801811000222']);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('New PO: two lines + transport + discount, "Send to supplier" → PDF orders it', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(NEW_PO));
  await expect(page.getByRole('heading', { name: /New purchase order/, level: 1 })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/PO-\d+ · Draft|Draft/).first()).toBeVisible();

  // supplier picker (composed): a "Choose supplier" / "Change" trigger or a combobox labelled Supplier
  const combo = page.getByRole('combobox', { name: /Supplier/ });
  if (await combo.isVisible().catch(() => false)) {
    await combo.click();
    await page.getByRole('option', { name: new RegExp(SUPPLIER) }).first().click();
  } else {
    await pickInDialog(page, button(page, /^(Choose supplier|Select supplier|Pick a supplier|Change)$/), SUPPLIER);
  }
  await expect(page.getByText(/Delivers in ~5 days/).first()).toBeVisible();

  await pickInDialog(page, button(page, /Add product/), 'QA Muslin Wrap');
  await pickInDialog(page, button(page, /Add product/), 'QA Cotton Kurta', /QA Cotton Kurta.*\bM\b|^M\b/);
  const line = (name: string) => page.getByRole('row').filter({ hasText: name }).or(page.getByRole('group').filter({ hasText: name })).first();
  const fillLine = async (name: string, qty: string, cost: string) => {
    const r = line(name);
    await r.getByRole('spinbutton', { name: /Quantity|Qty/i }).or(r.getByLabel(/Quantity|Qty/i)).first().fill(qty);
    await r.getByRole('spinbutton', { name: /Unit cost/i }).or(r.getByLabel(/Unit cost/i)).first().fill(cost);
  };
  await fillLine('QA Muslin Wrap', '10', '250');
  await fillLine('QA Cotton Kurta', '5', '600');
  await page.getByLabel(/^Transport/i).first().fill('121');
  await page.getByLabel(/Supplier discount/i).first().fill('11');
  // 10 × ৳ 250 + 5 × ৳ 600 + ৳ 121 − ৳ 11 = ৳ 5,610
  await expect(page.getByText(/Stock value goes up by ৳\s?5,610/).first()).toBeVisible();
  await expect(page.getByText(/Cost prices update automatically/).first()).toBeVisible();
  await expect(page.getByText(/need owner approval/i)).toHaveCount(0);
  await expect(page.getByText(/Receive at/i)).toHaveCount(0);

  await sendToSupplier(page).click();
  const channel = (name: RegExp) => page.getByRole('menuitem', { name }).or(dialog(page).getByRole('button', { name })).or(page.getByRole('menuitemradio', { name })).first();
  await expect(channel(/WhatsApp/)).toBeVisible();
  await expect(channel(/Email/), 'Email channel hidden (P88B-14)').toHaveCount(0);
  const created = waitApi(page, 'POST', /\/purchase-orders$/);
  const sent = waitApi(page, 'POST', /\/purchase-orders\/[0-9A-Za-z]{26}\/send$/);
  const popup = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
  await channel(/PDF/).click();
  const createdRes = await created;
  expect(createdRes.status(), await createdRes.text()).toBe(201);
  const sentRes = await sent;
  expect(sentRes.status(), await sentRes.text()).toBe(200);
  expect(sentRes.request().postDataJSON()).toMatchObject({ sent_via: 'pdf' });
  const opened = await popup;
  if (opened) test.info().annotations.push({ type: 'pdf', description: `PDF opened in a new tab: ${opened.url()}` });
  poId = (await createdRes.json()).data.id;

  const d = await po(shop.s, poId);
  number = d.number;
  expect(d).toMatchObject({ status: 'ordered', sent_via: 'pdf', subtotal_amount: 550_000, shipping_amount: 12_100, discount_amount: 1_100, total_amount: 561_000 });
  expect(d.supplier.id).toBe(supplierId);
  expect(lineFor(d, shop.simple.variantId)).toMatchObject({ unit_cost_amount: 25_000, quantity_ordered: 10 });
  expect(lineFor(d, shop.variable.variants[0].id)).toMatchObject({ unit_cost_amount: 60_000, quantity_ordered: 5 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('Receive part with 1 damaged: footer copy, Idempotency-Key, Partly received, "Received · PO-n" movements', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openPo(page, poId, number);
  await expect(statusPill(page, /^Ordered$/)).toBeVisible();

  const wrap = receiveInputs(page, 'QA Muslin Wrap');
  await wrap.now.fill('4');
  await wrap.damaged.fill('1');
  const kurta = receiveInputs(page, 'QA Cotton Kurta');
  await kurta.now.fill('2');
  await expect(page.getByText(/Adding 6 units to stock/).first()).toBeVisible();
  await expect(page.getByText(/1 damaged, not added to stock/).first()).toBeVisible();
  await expect(page.getByText(/cost prices updated/i).first()).toBeVisible();

  const posted = waitApi(page, 'POST', /\/receipts$/);
  await expect(receiveUnits(page)).toHaveText(/Receive 6 units/);
  await receiveUnits(page).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  expect(res.request().headers()['idempotency-key'], 'receipts send an Idempotency-Key').toBeTruthy();
  expect(res.request().postDataJSON().lines).toEqual(
    expect.arrayContaining([expect.objectContaining({ received: 4, damaged: 1 }), expect.objectContaining({ received: 2 })]),
  );
  await expect(statusPill(page, /^(Partly|Partially) received$/)).toBeVisible();
  expect((await variantOf(shop.s, shop.simple.id, shop.simple.variantId)).inventory.on_hand).toBe(14);

  await page.goto(mUrl(MOVEMENTS));
  await expect(inventoryTab(page, 'Stock movements')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(new RegExp(`Received · ${number}`)).first()).toBeVisible();
  await expect(page.getByText(SUPPLIER).first()).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('Record payment ৳ 1,000, then "Receive all remaining" → Received', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openPo(page, poId, number);

  await recordPayment(page).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByLabel(/^Amount/i).first().fill('1000');
  const paid = waitApi(page, 'POST', /\/suppliers\/[0-9A-Za-z]{26}\/payments$/);
  await d.getByRole('button', { name: /^(Record payment|Save payment|Save)$/ }).last().click();
  const pr = await paid;
  expect(pr.status(), await pr.text()).toBe(201);
  expect(pr.request().postDataJSON()).toMatchObject({ amount: 100_000, purchase_order_id: poId });
  await expect(statusPill(page, /^Partly paid$|^Partially paid$/)).toBeVisible();

  await receiveAllRemaining(page).click();
  await expect(receiveUnits(page)).toHaveText(/Receive 8 units/);
  const posted = waitApi(page, 'POST', /\/receipts$/);
  await receiveUnits(page).click();
  expect((await posted).status()).toBe(201);
  await expect(statusPill(page, /^Received$/)).toBeVisible();
  expect(await pageOverflow(page)).toBeNull();

  const list = await poList(shop.s, 'filter[status]=received');
  expect(list.data.map((x) => x.id)).toContain(poId);
  expect(list.meta.counts.received).toBeGreaterThanOrEqual(1);
  expect((await po(shop.s, poId))).toMatchObject({ status: 'received', paid_amount: 100_000, units_left: 0 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
