import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, signInDashboard, type ThrowawayMember } from '../support/api';
import { report } from '../support/billing';
import { setPlan } from '../support/commerce';
import { createRole, myMembership, noAccess, sidebar, watchConsole, type PermissionKey } from '../support/roles';
import {
  EXPENSES,
  createExpense,
  epath,
  expenseShop,
  exportCsv,
  monthName,
  mUrl,
  openExpenses,
  reportsTab,
  summary,
  tile,
  tinyPdf,
  type ExpenseShop,
} from '../support/expenses';

/**
 * PHASE-8-7 §13 QA access (P87-5, P87-6, P87-16, §2, S142):
 *  - staff (no `expenses.manage`) → 403 on every §8.1 route, no Expenses tab, Forbidden state on `/reports/expenses`;
 *  - a custom role with ONLY `expenses.manage` → Reports nav item visible, `/reports` lands on `/reports/expenses` (not
 *    Forbidden), only the Expenses tab, can record an expense, `profit_after_expenses_amount` null, no profit tile, profit
 *    report 403;
 *  - Starter owner → the ledger works (no plan gate, P87-6), summary profit null, Expenses shows 3 tiles.
 */
test.describe.configure({ mode: 'serial' });

let shop: ExpenseShop;
let staff: ThrowawayMember | undefined;
let clerk: ThrowawayMember | undefined;
let expenseId = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await expenseShop('exa', 'growth');
  expenseId = (await createExpense(shop.s, { amount: 30000, category: 'packaging', paid_from: 'cash', spent_on: shop.today, note: 'QA poly bags' })).id;
  staff = await createMember(shop.s, 'staff');
  const role = await createRole(shop.s, 'QA Expenses clerk', ['expenses.manage' as PermissionKey]);
  clerk = await createMember(shop.s, { role_id: role.id as string });
});
test.afterAll(async () => {
  await staff?.cleanup();
  await clerk?.cleanup();
  shop?.cleanup();
});

/** Every §8.1 route with a body where it needs one. */
function routes(): Array<[string, string, { json?: unknown; multipart?: Record<string, { name: string; mimeType: string; buffer: Buffer }> }]> {
  const s = shop.s;
  const body = { amount: 1000, category: 'other', paid_from: 'cash', spent_on: shop.today };
  return [
    ['GET', `${epath(s)}?filter[month]=${shop.month}`, {}],
    ['GET', `${epath(s, '/summary')}?month=${shop.month}`, {}],
    ['POST', epath(s), { json: body }],
    ['GET', epath(s, `/${expenseId}`), {}],
    ['PATCH', epath(s, `/${expenseId}`), { json: { amount: 2000 } }],
    ['DELETE', epath(s, `/${expenseId}`), {}],
    ['POST', epath(s, '/receipts'), { multipart: { file: { name: 'qa.pdf', mimeType: 'application/pdf', buffer: tinyPdf() } } }],
    ['GET', epath(s, `/${expenseId}/receipt`), {}],
    ['GET', `${epath(s, '/export')}?month=${shop.month}`, {}],
  ];
}

test('staff: 403 on every §8.1 route; no expenses.manage in /auth/me (S142)', async () => {
  const m = await myMembership(staff!.session);
  expect(m.permissions ?? [], 'staff permissions').not.toContain('expenses.manage');
  for (const [method, path, opts] of routes()) {
    const r = await apiCall(staff!.session, method, path, opts);
    expect([r.status, r.json.error?.code], `${method} ${path}`).toEqual([403, 'forbidden']);
  }
  expect((await api(shop.s, 'GET', epath(shop.s, `/${expenseId}`))).status, 'staff did not delete it').toBe(200);
});

test('UI staff: no Expenses tab; /reports/expenses shows the no-access state', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, staff!.session);
  await page.goto(mUrl('/reports/sales'));
  await expect(reportsTab(page, /^Sales/).first()).toBeVisible({ timeout: 20_000 });
  await expect(reportsTab(page, /^Expenses/)).toHaveCount(0);
  await page.goto(mUrl(EXPENSES));
  await expect(noAccess(page)).toBeVisible({ timeout: 15_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('custom role with only expenses.manage: routes work, profit null, profit report 403 (P87-5, S142)', async () => {
  const s = clerk!.session;
  const m = await myMembership(s);
  expect(m.permissions).toContain('expenses.manage');
  expect(m.permissions).not.toContain('reports.view');
  const own = await createExpense({ ...s, storeId: shop.s.storeId }, { amount: 45000, category: 'courier', paid_from: 'cash', spent_on: shop.today, note: 'QA pickup charge' });
  expect(own.created_by?.id, 'created_by = the clerk').toBeTruthy();
  const sum = await summary(shop.s, shop.month, s);
  expect(sum.profit_after_expenses_amount, 'no reports.view / costs.view → null, not 403').toBeNull();
  expect(sum.delivered_orders_count).toBe(0);
  expect(sum.total_amount).toBe(30000 + 45000);
  const csv = await exportCsv(shop.s, shop.month, s);
  expect(csv.status).toBe(200);
  const p = await report(shop.s, 'profit', shop.monthStart, shop.today, s);
  expect(p.status).toBe(403);
});

test('UI custom role: Reports nav visible, /reports → /reports/expenses, only the Expenses tab, no profit tile (P87-16)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, clerk!.session);
  await page.goto(mUrl('/'));
  await expect(sidebar(page).getByRole('link', { name: /^Reports$/ }).or(sidebar(page).getByRole('button', { name: /^Reports$/ })).first()).toBeVisible({ timeout: 20_000 });
  await page.goto(mUrl('/reports'));
  await expect(page).toHaveURL(/\/reports\/expenses/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /^Expenses$/, level: 1 })).toBeVisible();
  await expect(noAccess(page)).toHaveCount(0);
  await expect(reportsTab(page, /^Expenses/).first()).toBeVisible();
  for (const other of [/^Sales/, /^Profit/, /^Delivery/]) await expect(reportsTab(page, other), `${other} tab hidden`).toHaveCount(0);
  await expect(page.getByText('Profit after expenses', { exact: true })).toHaveCount(0);
  await expect(tile(page, `Spent in ${monthName(shop.month)}`)).toBeVisible();
  await expect(tile(page, 'Cost per order')).toBeVisible();
  // Sales/Profit/Delivery stay gated by can.viewReports: redirected away or the no-access state
  await page.goto(mUrl('/reports/profit'));
  await expect
    .poll(async () => !/\/reports\/profit/.test(page.url()) || (await noAccess(page).count()) > 0, { timeout: 15_000, message: '/reports/profit gated' })
    .toBe(true);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test.describe('Starter owner', () => {
  let starter: ExpenseShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    starter = await expenseShop('exs', 'starter');
  });
  test.afterAll(() => starter?.cleanup());

  test('ledger works on Starter (P87-6); summary profit null; Expenses shows 3 tiles', async ({ page, context }) => {
    test.setTimeout(90_000);
    await createExpense(starter.s, { amount: 99900, category: 'ads', paid_from: 'card', spent_on: starter.today, note: 'QA starter ads' });
    const sum = await summary(starter.s, starter.month);
    expect(sum).toMatchObject({ total_amount: 99900, ads_amount: 99900, ads_share: 1, profit_after_expenses_amount: null });
    const p = await report(starter.s, 'profit', starter.monthStart, starter.today);
    expect([p.status, p.json.error?.code]).toEqual([402, 'feature_not_in_plan']);

    const c = watchConsole(page);
    await signInDashboard(context, starter.s);
    await openExpenses(page);
    await expect(tile(page, `Spent in ${monthName(starter.month)}`)).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, 'Ads')).toBeVisible();
    await expect(tile(page, 'Cost per order')).toBeVisible();
    await expect(page.getByText('Profit after expenses', { exact: true })).toHaveCount(0);
    await expect(tile(page, 'Cost per order')).toContainText('—');
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });

  test('Free plan: ledger still open (P87-6)', async () => {
    setPlan(starter.s, 'free');
    const r = await api(starter.s, 'POST', epath(starter.s), { amount: 1000, category: 'other', paid_from: 'cash', spent_on: starter.today });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const s = await summary(starter.s, starter.month);
    expect(s.profit_after_expenses_amount).toBeNull();
  });
});
