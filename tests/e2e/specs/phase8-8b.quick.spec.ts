import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { listExpenses, profit, summary } from '../support/expenses';
import { watchConsole } from '../support/roles';
import {
  audit,
  createSupplier,
  dialog,
  openPoList,
  poList,
  poMovements,
  purchasingShop,
  quickPurchaseButton,
  quickRaw,
  supplier,
  today,
  variantOf,
  weightedCost,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA quick purchase (P88B-13, §5.5; S170, S172, S174, S175):
 *  - `POST …/purchase-orders/quick` with 6 pieces (1 damaged) at ৳ 300 and a ৳ 1,500 cash payment → one PO `received`
 *    (sent_via null, ordered = 6), one receipt (5 received, 1 damaged), stock +5 through the ledger, cost = weighted
 *    average, payment linked → partially paid against the total ৳ 1,800, owed 0 (damaged not owed, Q206);
 *  - the same Idempotency-Key again → the same PO, nothing doubled; no key → 400/422;
 *  - Profit & loss for today and the expenses month are byte-identical before and after (purchases are not expenses);
 *  - one `purchasing.quick_received` audit row;
 *  - UI: the PO list has a "Quick purchase" button opening a dialog with supplier, lines, transport, discount, payment.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let sup: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('poq', 'growth', 10);
  sup = await createSupplier(shop.s, { name: `QA Chawkbazar Wholesale ${randomUUID().slice(0, 4)}`, payment_terms_days: null });
});
test.afterAll(() => shop?.cleanup());

/** Drops volatile keys (`*_at`, `as_of`) so two report reads can be compared. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/(_at|^as_of)$/.test(k)).map(([k, x]) => [k, stable(x)]));
  return v;
}

test('quick purchase: one received PO + receipt + payment, idempotent; P&L and expenses unchanged (S170, S175)', async () => {
  const day = today();
  const month = day.slice(0, 7);
  const plBefore = stable(await profit(shop.s, day, day));
  const exBefore = stable(await summary(shop.s, month));
  const v0 = await variantOf(shop.s, shop.simple.id, shop.simple.variantId);

  const key = randomUUID();
  const body = {
    supplier_id: sup.id,
    lines: [{ variant_id: shop.simple.variantId, unit_cost_amount: 30_000, quantity: 6, damaged: 1 }],
    shipping_amount: 0,
    discount_amount: 0,
    payment: { amount: 150_000, method: 'cash', paid_on: day },
    supplier_invoice_ref: 'INV-QA-77',
  };
  const r = await quickRaw(shop.s, body, key);
  expect(r.status, r.text.slice(0, 400)).toBe(201);
  const d = r.json.data;
  expect(d).toMatchObject({ status: 'received', sent_via: null, total_amount: 180_000, received_value_amount: 150_000, paid_amount: 150_000, payment_status: 'partially_paid', units_received: 5, units_damaged: 1, units_left: 0 });
  expect(d.number).toMatch(/^PO-\d+$/);
  expect(d.lines[0]).toMatchObject({ quantity_ordered: 6, quantity_received: 5, quantity_damaged: 1 });
  expect(d.receipts).toHaveLength(1);
  expect(d.receipts[0]).toMatchObject({ supplier_invoice_ref: 'INV-QA-77', units_received: 5, units_damaged: 1, value_amount: 150_000 });
  expect(d.payments).toHaveLength(1);
  expect((d.events as Array<{ type: string }>).map((e) => e.type)).toContain('quick_received');

  const v1 = await variantOf(shop.s, shop.simple.id, shop.simple.variantId);
  expect(v1.inventory.on_hand).toBe(v0.inventory.on_hand + 5);
  expect(v1.cost_amount).toBe(weightedCost(v0.inventory.on_hand, v0.cost_amount, 5, 30_000));
  const moves = await poMovements(shop.s, d.id);
  expect(moves.map((m) => [m.reason, m.delta])).toEqual([['received', 5]]);
  expect((await supplier(shop.s, sup.id)).owed_amount, 'received value − payments; damaged not owed').toBe(0);

  // replay: same PO, nothing doubled
  const again = await quickRaw(shop.s, body, key);
  expect([200, 201], again.text.slice(0, 200)).toContain(again.status);
  expect(again.json.data.id).toBe(d.id);
  expect((await poList(shop.s, `filter[supplier_id]=${sup.id}`)).data).toHaveLength(1);
  expect((await variantOf(shop.s, shop.simple.id, shop.simple.variantId)).inventory.on_hand).toBe(v0.inventory.on_hand + 5);
  expect(await poMovements(shop.s, d.id)).toHaveLength(1);
  // Idempotency-Key is required
  const noKey = await quickRaw(shop.s, body, null);
  expect([400, 422], noKey.text.slice(0, 200)).toContain(noKey.status);

  expect(stable(await profit(shop.s, day, day)), 'Profit & loss unchanged by a purchase').toEqual(plBefore);
  expect(stable(await summary(shop.s, month)), 'expense summary unchanged').toEqual(exBefore);
  expect(await listExpenses(shop.s, month)).toEqual([]);
  expect((await audit(shop.s)).filter((a) => a.action === 'purchasing.quick_received')).toHaveLength(1);
});

test('UI: "Quick purchase" opens the dialog (supplier, lines, transport, discount, payment)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openPoList(page);
  await quickPurchaseButton(page).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole('heading', { name: /Quick purchase/ }).or(d.getByText(/Quick purchase/).first()).first()).toBeVisible();
  for (const label of [/Supplier/, /Transport/, /discount/i, /Pa(id|yment)/]) await expect(d.getByText(label).first(), String(label)).toBeVisible();
  await expect(d.getByRole('button', { name: /Add product/ }).first()).toBeVisible();
  await d.getByRole('button', { name: /^(Cancel|Close)$/ }).first().click();
  await expect(d).toBeHidden();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
