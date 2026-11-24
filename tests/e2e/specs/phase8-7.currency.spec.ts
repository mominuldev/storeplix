import { expect, test } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import { orderIdByNumber, placeOrder, transition } from '../support/commerce';
import { CURRENCY_LOCKED_CAPTION, createExpense, deleteExpense, expenseShop, mUrl, type ExpenseShop } from '../support/expenses';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-7 §13 QA currency lock + AC 6 (P87-18, §6.4, S153): a store with neither orders nor expenses can switch
 * currency (`region.currency_locked` false); one expense locks it (409 `currency_locked`, currency unchanged, same
 * currency still 200); deleting that only expense unlocks it again (the rule is an EXISTS check); one **cancelled** order
 * locks it too. Store details shows the disabled Currency select with "Locked after your first order or expense.".
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: ExpenseShop;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  shop = await expenseShop('exc', 'starter');
});
test.afterAll(() => shop?.cleanup());

const settings = async (): Promise<Json> => {
  const r = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/settings`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
};
const setCurrency = (currency: string) => api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/settings`, { region: { currency } });

test('no orders, no expenses: unlocked, currency change applies', async () => {
  expect((await settings()).region).toMatchObject({ currency: 'BDT', currency_locked: false });
  const usd = await setCurrency('USD');
  expect(usd.status, JSON.stringify(usd.json)).toBe(200);
  expect((await settings()).region.currency).toBe('USD');
  const back = await setCurrency('BDT');
  expect(back.status).toBe(200);
  expect((await settings()).region.currency).toBe('BDT');
});

test('one expense locks it: 409 currency_locked, unchanged; same currency 200; delete → unlocked (S153)', async () => {
  const e = await createExpense(shop.s, { amount: 10000, category: 'other', paid_from: 'cash', spent_on: shop.today });
  expect(e.currency).toBe('BDT');
  expect((await settings()).region.currency_locked).toBe(true);
  const usd = await setCurrency('USD');
  expect([usd.status, usd.json.error?.code], JSON.stringify(usd.json)).toEqual([409, 'currency_locked']);
  expect(usd.json.error.message).toMatch(/can.t be changed after the first order or expense/);
  expect((await settings()).region.currency).toBe('BDT');
  expect((await setCurrency('BDT')).status, 'same currency still saves').toBe(200);
  await deleteExpense(shop.s, e.id);
  expect((await settings()).region.currency_locked, 'no order, no expense left').toBe(false);
});

test('one cancelled order locks it (any status)', async () => {
  const placed = await placeOrder(shop, shop.simple.variantId, 1);
  const id = await orderIdByNumber(shop.s, placed.order.number);
  expect((await transition(shop.s, id, 'cancel', { reason: 'customer_request', notify_customer: false })).status).toBe(200);
  expect((await settings()).region.currency_locked).toBe(true);
  const usd = await setCurrency('USD');
  expect([usd.status, usd.json.error?.code]).toEqual([409, 'currency_locked']);
});

test('UI Store details: Currency select disabled with the lock caption (§6.4)', async ({ page, context }) => {
  test.setTimeout(60_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/settings/store'));
  const currency = page.getByLabel(/^Currency/).first();
  await expect(currency).toBeVisible({ timeout: 20_000 });
  await expect(currency).toBeDisabled();
  await expect(page.getByText(CURRENCY_LOCKED_CAPTION).first()).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
