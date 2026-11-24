import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import { chooseOption, createLocation, defaultLocation, DHANMONDI, movementsWhere, mUrl, stockAt } from '../support/locations';
import { inventoryTab, MOVEMENTS, purchasingShop, waitApi } from '../support/purchasing';
import {
  addTransferProduct,
  createTransfer,
  lineOf,
  newTransferButton,
  openTransfer,
  openTransfers,
  panel,
  sendTransfer,
  transfer,
  transferActionRaw,
  transferRow,
  transferStockButton,
  TR_NUMBER,
} from '../support/transfers';

/**
 * PHASE-8-8C §13 QA part B (transfers), AC 4, P88C-9/10, §7, §10.4, S188: Growth shop, stock 6 per variant at "Main
 * warehouse" (default), "Dhanmondi shop" added.
 *  (a) Inventory "Transfer stock" → panel From Main / To Dhanmondi, "+ Add product" kurta M × 4 and the wrap × 3
 *      ("Main warehouse stock 6 → 3", wrap threshold 5 → warning "… online orders may sell out") → "Save draft" (201,
 *      TR-nnn, pill Draft, no stock change) → "Send" (Idempotency-Key, In transit, Main M 2 / wrap 3, Dhanmondi 0) →
 *      "Receive": M 4, wrap 1 ("2 short" live, confirm "Receive with 2 short?") → pill "Received · 2 short"; Dhanmondi
 *      M 4 / wrap 1; Main unchanged; short never re-enters stock (S188).
 *  (b) Movements: `transfer_out` at Main (−4, −3) and `transfer_in` at Dhanmondi (+4, +1), reference `stock_transfer`;
 *      the Stock movements tab shows "Transfer → Dhanmondi shop".
 *  (c) Cancel in transit (UI menu "Cancel transfer"): sent units return to the source exactly once (S188), pill
 *      Cancelled; a second cancel / a receive → 409 `invalid_state_transition`.
 *  (d) Send never takes the source below available (P88C-10): a line > available → 422 `insufficient_stock`.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let main: Json;
let dhan: Json;
let trId = '';
let trNumber = '';
const vM = () => shop.variable.variants[0].id as string;
const vW = () => shop.simple.variantId;
const vL = () => shop.variable.variants[1].id as string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('trf', 'growth', 6);
  main = await defaultLocation(shop.s);
  dhan = await createLocation(shop.s, DHANMONDI);
});
test.afterAll(() => shop?.cleanup());

test('(a) Transfer stock → draft → Send: stock leaves Main on send', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/inventory'));
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 20_000 });
  await transferStockButton(page).click();
  const p = panel(page);
  await expect(p).toBeVisible();
  await chooseOption(p, page, /^From/i, 'Main warehouse');
  await chooseOption(p, page, /^To/i, DHANMONDI);
  await addTransferProduct(page, p, 'QA Cotton Kurta', 'Add QA Cotton Kurta M');
  await addTransferProduct(page, p, 'QA Muslin Wrap', 'Add QA Muslin Wrap');
  await p.getByRole('spinbutton', { name: 'Quantity of QA Cotton Kurta M' }).fill('4');
  await p.getByRole('spinbutton', { name: 'Quantity of QA Muslin Wrap' }).fill('3');
  // "{From} stock a → b" (§10.4): Main 6 → 2 for M, 6 → 3 for the wrap (threshold 5 → red + warning)
  await expect(p.getByText(/Main warehouse stock 6 → 2/).first()).toBeVisible();
  await expect(p.getByText(/Main warehouse stock 6 → 3/).first()).toBeVisible();
  // P88C-10: the wrap drops to its low-stock level at the online location → the panel warns
  await expect(p.getByText(/(2 products will drop to their low-stock level|QA Muslin Wrap will drop to 3) in Main warehouse — online orders may sell out/).first()).toBeVisible();

  const saved = waitApi(page, 'POST', /\/stock-transfers$/);
  await p.getByRole('button', { name: /^Save draft$/ }).click();
  const res = await saved;
  expect(res.status(), await res.text()).toBe(201);
  const draft = (await res.json()).data as Json;
  trId = draft.id;
  trNumber = draft.number;
  expect(trNumber).toMatch(TR_NUMBER);
  expect(draft).toMatchObject({ status: 'draft' });
  expect(await stockAt(shop.s, vM(), main.id)).toMatchObject({ on_hand: 6 });

  await openTransfers(page);
  const row = transferRow(page, trNumber);
  await expect(row).toBeVisible();
  await expect(row.getByText(/^Draft$/)).toBeVisible();
  await expect(row.getByText(DHANMONDI).first()).toBeVisible();

  await openTransfer(page, trNumber);
  const d = panel(page);
  await expect(d.getByText(trNumber).first()).toBeVisible();
  await expect(d.getByText(/Created by/).first()).toBeVisible();
  const sent = waitApi(page, 'POST', /\/stock-transfers\/[0-9A-Za-z]{26}\/send$/);
  await d.getByRole('button', { name: /^Send/ }).click();
  const sres = await sent;
  expect(sres.status(), await sres.text()).toBe(200);
  expect(sres.request().headers()['idempotency-key'], 'send carries an Idempotency-Key (§7)').toBeTruthy();

  expect(await stockAt(shop.s, vM(), main.id)).toEqual({ on_hand: 2, committed: 0, available: 2 });
  expect(await stockAt(shop.s, vW(), main.id)).toEqual({ on_hand: 3, committed: 0, available: 3 });
  expect(await stockAt(shop.s, vM(), dhan.id)).toMatchObject({ on_hand: 0 });
  expect((await transfer(shop.s, trId)).status).toBe('in_transit');
  await expect(transferRow(page, trNumber).getByText(/^In transit$/)).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(a) Receive with 2 short: Dhanmondi up, pill "Received · 2 short", short never re-enters stock', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openTransfers(page);
  await openTransfer(page, trNumber);
  const d = panel(page);
  await expect(d.getByText(trNumber).first()).toBeVisible();
  const inM = d.getByRole('spinbutton', { name: 'Received of QA Cotton Kurta M' });
  const inW = d.getByRole('spinbutton', { name: 'Received of QA Muslin Wrap' });
  // "Receive all" fills every line with the sent quantity
  await d.getByRole('button', { name: 'Receive all' }).click();
  await expect(inM).toHaveValue('4');
  await expect(inW).toHaveValue('3');
  await expect(d.getByText(/7 received · 0 short/)).toBeVisible();
  await inW.fill('1');
  await expect(d.getByText(/5 received · 2 short/), 'short shown live').toBeVisible();
  const recv = waitApi(page, 'POST', /\/stock-transfers\/[0-9A-Za-z]{26}\/receive$/);
  await d.getByRole('button', { name: 'Receive', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Receive with 2 short?' }).or(page.getByRole('alertdialog', { name: 'Receive with 2 short?' })).first();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Receive', exact: true }).click();
  const rres = await recv;
  expect(rres.status(), await rres.text()).toBe(200);
  const body = rres.request().postDataJSON() as { lines: Array<{ item_id: string; received: number }> };
  expect(body.lines.map((l) => l.received).sort()).toEqual([1, 4]);

  await expect(transferRow(page, trNumber).getByText(/Received · 2 short/)).toBeVisible();
  const t = await transfer(shop.s, trId);
  expect(t).toMatchObject({ status: 'received', units_sent: 7, units_received: 5, units_short: 2 });
  expect(lineOf(t, vM())).toMatchObject({ quantity: 4, quantity_received: 4 });
  expect(lineOf(t, vW())).toMatchObject({ quantity: 3, quantity_received: 1 });

  expect(await stockAt(shop.s, vM(), dhan.id)).toEqual({ on_hand: 4, committed: 0, available: 4 });
  expect(await stockAt(shop.s, vW(), dhan.id)).toEqual({ on_hand: 1, committed: 0, available: 1 });
  expect(await stockAt(shop.s, vM(), main.id)).toMatchObject({ on_hand: 2 });
  expect(await stockAt(shop.s, vW(), main.id), 'short is written off, never returned (P88C-9)').toMatchObject({ on_hand: 3 });
  await expect(d.getByText(/5 of 7 units received · 2 short, written off/)).toBeVisible();

  // received is final: a second receive / a cancel → 409
  for (const action of ['receive', 'cancel'] as const) {
    const r = await transferActionRaw(shop.s, trId, action, action === 'receive' ? { lines: t.lines.map((l: Json) => ({ item_id: l.id, received: 0 })) } : {});
    expect([r.status, r.json.error?.code], `${action} after receive`).toEqual([409, 'invalid_state_transition']);
  }
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(b) movements show both sides: transfer_out at Main, transfer_in at Dhanmondi', async ({ page, context }) => {
  test.setTimeout(90_000);
  const out = (await movementsWhere(shop.s, { reason: 'transfer_out' })).filter((m) => m.reference?.id === trId);
  const inn = (await movementsWhere(shop.s, { reason: 'transfer_in' })).filter((m) => m.reference?.id === trId);
  const key = (m: Json) => [m.variant_id, m.delta, m.location?.id];
  expect(out.map(key).sort()).toEqual([[vM(), -4, main.id], [vW(), -3, main.id]].sort());
  expect(inn.map(key).sort()).toEqual([[vM(), 4, dhan.id], [vW(), 1, dhan.id]].sort());
  for (const m of [...out, ...inn]) expect(m.reference?.type).toBe('stock_transfer');

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(MOVEMENTS));
  await expect(inventoryTab(page, 'Stock movements')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(new RegExp(`Transfer → ${DHANMONDI}`)).first()).toBeVisible({ timeout: 15_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(c) Cancel in transit returns exactly the sent units once (S188)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const before = await stockAt(shop.s, vM(), main.id); // 2
  const t = await createTransfer(shop.s, main.id, dhan.id, [{ variant_id: vM(), quantity: 2 }]);
  await sendTransfer(shop.s, t.id);
  expect(await stockAt(shop.s, vM(), main.id)).toMatchObject({ on_hand: before.on_hand - 2 });

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openTransfers(page);
  const row = transferRow(page, t.number);
  await expect(row.getByText(/^In transit$/)).toBeVisible();
  await openTransfer(page, t.number);
  const d = panel(page);
  await expect(d.getByText(t.number).first()).toBeVisible();
  await d.getByRole('button', { name: 'Transfer actions' }).click();
  await page.getByRole('menuitem', { name: /Cancel transfer/ }).click();
  const confirm = page.getByRole('dialog', { name: `Cancel ${t.number}?` }).or(page.getByRole('alertdialog', { name: `Cancel ${t.number}?` })).first();
  await expect(confirm.getByText(/The 2 units sent go back to Main warehouse/)).toBeVisible();
  const cancelled = waitApi(page, 'POST', /\/stock-transfers\/[0-9A-Za-z]{26}\/cancel$/);
  await confirm.getByRole('button', { name: 'Cancel transfer' }).click();
  const cres = await cancelled;
  expect(cres.status(), await cres.text()).toBe(200);
  await expect(transferRow(page, t.number).getByText(/^Cancelled$/)).toBeVisible();

  expect(await stockAt(shop.s, vM(), main.id)).toEqual(before);
  expect(await stockAt(shop.s, vM(), dhan.id)).toMatchObject({ on_hand: 4 });
  const back = (await movementsWhere(shop.s, { reason: 'transfer_in' })).filter((m) => m.reference?.id === t.id);
  expect(back.map((m) => [m.delta, m.location?.id])).toEqual([[2, main.id]]);
  expect(back[0].note ?? '').toMatch(/Cancelled/);

  const again2 = await transferActionRaw(shop.s, t.id, 'cancel');
  expect([again2.status, again2.json.error?.code]).toEqual([409, 'invalid_state_transition']);
  expect(await stockAt(shop.s, vM(), main.id), 'returned once only').toEqual(before);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(d) Send never takes the source below available (P88C-10)', async () => {
  const avail = (await stockAt(shop.s, vL(), main.id)).available; // 3
  const t = await createTransfer(shop.s, main.id, dhan.id, [{ variant_id: vL(), quantity: avail + 1 }]);
  const r = await transferActionRaw(shop.s, t.id, 'send');
  expect([r.status, r.json.error?.code], r.text.slice(0, 300)).toEqual([422, 'insufficient_stock']);
  expect(await stockAt(shop.s, vL(), main.id)).toMatchObject({ on_hand: avail });
  expect((await transfer(shop.s, t.id)).status).toBe('draft');
});
