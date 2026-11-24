import { expect, test } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import { moneyPattern } from '../support/analytics';
import { csvObjects, isFormulaUnsafe } from '../support/catalog';
import { deliveredOrder } from '../support/automations';
import {
  COURIER_HINT,
  addExpenseButton,
  canvasJpeg,
  categoryChip,
  choose,
  createExpense,
  deleteExpense,
  expectProfitIdentity,
  expectedExpenseLines,
  expenseCard,
  expenseRow,
  expenseShop,
  exportCsv,
  exportCsvButton,
  fetchRaw,
  fillExpenseCard,
  listExpenses,
  monthName,
  mUrl,
  openExpenses,
  profit,
  receiptLink,
  saveExpenseCard,
  summary,
  tile,
  type ExpenseShop,
} from '../support/expenses';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-7 §13 QA main flow + AC 1, AC 2, AC 3 (P87-2, P87-3, P87-4, P87-12, P87-14, S147, S148, S150, S151):
 * a Growth owner with one delivered order adds an Ads expense with a JPG receipt and a Rent & bills expense with
 * "Repeat every month" through the Expenses page → list, total, by-category and tiles update → the receipt opens through
 * the signed link (inline image) → Profit & loss shows Ad spend and Other expenses and a net profit lower by exactly their
 * sum → edit amount → P&L follows → delete → P&L back. Courier hint, CSV export (API + button), audit rows.
 * Every expected figure is recomputed from the expenses list / the "before" report, never copied from the screen.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: ExpenseShop;
let baseline: Json; // P&L summary of this month before any expense
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await expenseShop('exl', 'growth');
  await deliveredOrder(shop);
  baseline = (await profit(shop.s, shop.monthStart, shop.today)).summary as Json;
  expect(baseline.delivered_orders_count).toBe(1);
});
test.afterAll(() => shop?.cleanup());

test('no expenses: P&L lines are 0, Phase 7 net profit unchanged (§7.3); summary empty', async () => {
  expect(baseline).toMatchObject({ ad_spend_amount: 0, other_expenses_amount: 0 });
  expect(baseline.profit_before_expenses_amount).toBe(baseline.net_profit_amount);
  expectProfitIdentity(baseline, 'baseline');
  const sum = await summary(shop.s, shop.month);
  expect(sum).toMatchObject({ month: shop.month, total_amount: 0, count: 0, by_category: [], delivered_orders_count: 1 });
  expect(sum.ads_share).toBeNull();
  expect(sum.profit_after_expenses_amount, 'AC 3: tile = P&L net profit').toBe(baseline.net_profit_amount);
  expect(sum.months).toContain(shop.month);
});

test('UI: add an Ads expense with a JPG receipt and a Rent & bills expense with Repeat every month (AC 1)', async ({ page, context, browser }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  const jpg = await canvasJpeg(browser);
  await signInDashboard(context, shop.s);
  await openExpenses(page);
  await expect(page.getByText(new RegExp(`No expenses in ${monthName(shop.month)}`)).first(), 'empty month state').toBeVisible({ timeout: 20_000 });

  await addExpenseButton(page).click();
  await fillExpenseCard(page, { amount: '1500', category: 'ads', paidFrom: 'bKash', note: 'QA boost post', receipt: { name: 'qa-ads.jpg', mimeType: 'image/jpeg', buffer: jpg } });
  const ads = await saveExpenseCard(page);
  expect(ads).toMatchObject({ category: 'ads', paid_from: 'bkash', amount: 150000, currency: 'BDT', spent_on: shop.today, note: 'QA boost post', repeat_monthly: false });
  expect(ads.receipt).toMatchObject({ mime: 'image/jpeg' });
  ids.ads = ads.id;

  await addExpenseButton(page).click();
  await fillExpenseCard(page, { amount: '8000.50', category: 'rent_bills', paidFrom: 'Bank', note: 'QA shop rent', repeat: true });
  const rent = await saveExpenseCard(page);
  expect(rent).toMatchObject({ category: 'rent_bills', paid_from: 'bank', amount: 800050, spent_on: shop.today, repeat_monthly: true, receipt: null });
  expect(rent.recurrence_id).toMatch(/^[0-9A-Za-z]{26}$/);
  ids.rent = rent.id;

  // list + total row + by-category + tiles
  await expect(expenseRow(page, 'QA boost post')).toBeVisible({ timeout: 15_000 });
  await expect(expenseRow(page, 'QA shop rent')).toBeVisible();
  await expect(expenseRow(page, 'QA boost post').getByText(/Receipt attached/)).toBeVisible();
  await expect(expenseRow(page, 'QA shop rent').getByText(/Repeats monthly/)).toBeVisible();
  await expect(page.getByText(/2 expenses this month/).first()).toBeVisible();
  const total = 150000 + 800050;
  await expect(page.getByText(moneyPattern(total)).first()).toBeVisible();
  await expect(tile(page, `Spent in ${monthName(shop.month)}`)).toContainText(moneyPattern(total));
  await expect(tile(page, 'Ads')).toContainText(moneyPattern(150000));
  await expect(tile(page, 'Ads')).toContainText(/(16|15\.8)\s?% of expenses/); // 150000 / 950050 = 15.8 %
  const p = await profit(shop.s, shop.monthStart, shop.today);
  await expect(tile(page, 'Profit after expenses')).toContainText(moneyPattern(p.summary.net_profit_amount));
  await expect(tile(page, 'Cost per order')).toContainText(moneyPattern(total)); // floor(total / 1 delivered)
  await expect(tile(page, 'Cost per order')).toContainText(/1 delivered order/);
  const byCat = page.getByRole('heading', { name: /^By category/ }).first().locator('xpath=ancestor::*[self::section or @role="region" or contains(concat(" ", @class, " "), " rounded-card ")][1]');
  await expect(byCat).toContainText('Rent & bills');
  await expect(byCat).toContainText('Ads');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('summary maths (§6.3) and AC 3: profit tile equals P&L net profit', async () => {
  const s = await summary(shop.s, shop.month);
  const total = 150000 + 800050;
  expect(s).toMatchObject({ total_amount: total, count: 2, ads_amount: 150000, delivered_orders_count: 1, cost_per_order_amount: total, currency: 'BDT' });
  expect(s.ads_share).toBeCloseTo(150000 / total, 4);
  expect(s.by_category.map((r: Json) => r.category)).toEqual(['rent_bills', 'ads']);
  expect(s.by_category[0].share).toBeCloseTo(800050 / total, 4);
  const p = await profit(shop.s, s.from, s.to);
  expect(s.profit_after_expenses_amount).toBe(p.summary.net_profit_amount);
});

test('receipt opens through the signed link: 200 inline image, nosniff, CSP sandbox, no-store (§5.3, S144)', async () => {
  const { link } = await receiptLink(shop.s, ids.ads);
  expect(link).toMatchObject({ mime: 'image/jpeg' });
  expect(Date.parse(link.expires_at) - Date.now(), 'link lives 5 minutes').toBeLessThanOrEqual(5 * 60_000 + 5_000);
  expect(Date.parse(link.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000);
  const res = await fetchRaw(link.url);
  expect(res.status, res.text).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^image\/jpeg/);
  expect(res.headers.get('content-disposition')).toMatch(/^inline/);
  expect(res.headers.get('content-disposition')).toContain(`receipt-${shop.today}.jpg`);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  expect(res.headers.get('cache-control')).toMatch(/no-store/);
  expect(res.body.subarray(0, 2).toString('hex')).toBe('ffd8');
  // no receipt → 404 receipt_not_found
  const none = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/expenses/${ids.rent}/receipt`);
  expect([none.status, none.json.error?.code]).toEqual([404, 'receipt_not_found']);
});

test('Profit & loss: Ad spend = Ads, Other expenses = the rest, net profit lower by exactly their sum (AC 2, S150)', async () => {
  const r = await profit(shop.s, shop.monthStart, shop.today);
  const exp = await expectedExpenseLines(shop.s, shop.monthStart, shop.today);
  expect(exp).toEqual({ ads: 150000, other: 800050, count: 2 });
  expect(r.summary).toMatchObject({
    revenue_amount: baseline.revenue_amount,
    product_cost_amount: baseline.product_cost_amount,
    ad_spend_amount: 150000,
    other_expenses_amount: 800050,
    profit_before_expenses_amount: baseline.net_profit_amount,
    net_profit_amount: baseline.net_profit_amount - 150000 - 800050,
  });
  expectProfitIdentity(r.summary, 'summary');
  expect(r.data_quality.expenses_count).toBe(2);
  expect(r.per_order).toMatchObject({ ad_spend_amount: 150000, other_expenses_amount: 800050 });
  const day = (r.daily as Json[]).find((d) => d.date === shop.today);
  expect(day, 'daily row of today').toBeTruthy();
  expect(day).toMatchObject({ ad_spend_amount: 150000, other_expenses_amount: 800050 });
  expectProfitIdentity(day!, 'daily today');
});

test('UI Profit tab: Ad spend and Other expenses lines, "before expenses" line, no "Coming with Expenses" (§10.2)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(`/reports/profit?from=${shop.monthStart}&to=${shop.today}`));
  await expect(page.getByText(/Net profit/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Ad spend/).first()).toBeVisible();
  await expect(page.getByText(/Other expenses/).first()).toBeVisible();
  await expect(page.getByText(/Coming with Expenses/)).toHaveCount(0);
  await expect(page.getByText(/before expenses/).first()).toContainText(moneyPattern(baseline.net_profit_amount));
  await expect(page.getByRole('columnheader', { name: /AD SPEND|Ad spend/i }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /OTHER EXP|Other exp/i }).first()).toBeVisible();
  await expect(page.getByText(/No expenses recorded for this period/), 'zero-expense hint hidden when there are expenses').toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('UI edit: row → Edit expense card → new amount → list and P&L follow (P87-4, P87-12)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, shop.s);
  await openExpenses(page);
  await expenseRow(page, 'QA boost post').click();
  await expect(expenseCard(page, /^Edit expense$/)).toBeVisible({ timeout: 10_000 });
  await fillExpenseCard(page, { amount: '2000' });
  const saved = await saveExpenseCard(page, 'PATCH');
  expect(saved).toMatchObject({ id: ids.ads, amount: 200000 });
  // next profit response already reflects it (cache keyed by expenses_rev, no 120 s wait)
  const r = await profit(shop.s, shop.monthStart, shop.today);
  expect(r.summary.ad_spend_amount).toBe(200000);
  expect(r.summary.net_profit_amount).toBe(baseline.net_profit_amount - 200000 - 800050);
  await expect(tile(page, 'Ads')).toContainText(moneyPattern(200000), { timeout: 10_000 });
});

test('UI delete: Delete with confirm → row gone; P&L back without it (P87-13)', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, shop.s);
  await openExpenses(page);
  await expenseRow(page, 'QA boost post').click();
  const card = expenseCard(page, /^Edit expense$/);
  await card.getByRole('button', { name: /^Delete/ }).click();
  const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/expenses/${ids.ads}`));
  await page.getByRole('dialog').last().getByRole('button', { name: /^Delete/ }).click();
  expect((await del).status()).toBe(204);
  await expect(expenseRow(page, 'QA boost post')).toHaveCount(0, { timeout: 10_000 });
  const r = await profit(shop.s, shop.monthStart, shop.today);
  expect(r.summary).toMatchObject({ ad_spend_amount: 0, other_expenses_amount: 800050, net_profit_amount: baseline.net_profit_amount - 800050 });
  const gone = await api(shop.s, 'GET', `/stores/${shop.s.storeId}/expenses/${ids.ads}`);
  expect(gone.status).toBe(404);
});

test('UI: Courier category shows the "Only charges not already on courier invoices…" hint (§3)', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openExpenses(page);
  await addExpenseButton(page).click();
  const card = expenseCard(page);
  await expect(card.getByText(COURIER_HINT)).toHaveCount(0);
  await choose(card, /^Category/, 'Courier');
  await expect(card.getByText(COURIER_HINT).first()).toBeVisible();
  // composed chips: all six categories
  for (const label of ['All', 'Ads', 'Packaging', 'Salaries', 'Rent & bills', 'Courier', 'Other']) await expect(categoryChip(page, label), `chip ${label}`).toBeVisible();
});

test('validation (S147): amount ≤ 0 / > 1e9 / decimal / string, future date, before 2020, wrong currency → 422; mass assignment ignored', async () => {
  const base = { amount: 1000, category: 'other', paid_from: 'cash', spent_on: shop.today };
  const tomorrow = new Date(Date.parse(`${shop.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 1_000_000_001 }, { amount: 10.5 }, { amount: 'ten' }, { spent_on: tomorrow }, { spent_on: '2019-12-31' }, { currency: 'USD' }, { category: 'travel' }, { paid_from: 'rocket' }]) {
    const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/expenses`, { ...base, ...bad });
    expect([r.status, r.json.error?.code], `${JSON.stringify(bad)} → ${JSON.stringify(r.json)}`).toEqual([422, 'validation_failed']);
  }
  const created = await createExpense(shop.s, { ...base, note: '=HYPERLINK("http://x")', tenant_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', store_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', created_by: null } as never);
  expect(created.currency).toBe('BDT');
  expect(created.created_by, 'created_by from the actor, not the body').not.toBeNull();
  ids.formula = created.id;
});

test('CSV export (P87-14, S148): API attachment with the contract columns, formula cells neutralized, only this month; button downloads', async ({ page, context }) => {
  test.setTimeout(90_000);
  const r = await exportCsv(shop.s, shop.month);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.headers['content-type']).toMatch(/^text\/csv/);
  const slug = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}`)).json.data.slug as string;
  expect(r.headers['content-disposition']).toMatch(new RegExp(`attachment;.*expenses-${slug}-${shop.month}\\.csv`));
  const rows = csvObjects(r.text);
  expect(Object.keys(rows[0] ?? {})).toEqual(['date', 'category', 'note', 'paid_from', 'amount', 'currency', 'receipt', 'repeats']);
  const listed = await listExpenses(shop.s, shop.month);
  expect(rows).toHaveLength(listed.length);
  const rent = rows.find((x) => x.note === 'QA shop rent');
  expect(rent).toMatchObject({ date: shop.today, amount: '8000.50', currency: 'BDT', receipt: 'no', repeats: 'yes' });
  const formula = rows.find((x) => x.note.includes('HYPERLINK'));
  expect(formula, 'formula note row').toBeTruthy();
  expect(isFormulaUnsafe(formula!.note), `neutralized: ${formula!.note}`).toBe(false);
  const prev = await exportCsv(shop.s, shop.prevMonth);
  expect(prev.status).toBe(200);
  expect(csvObjects(prev.text).filter((x) => x.note?.startsWith('QA '))).toHaveLength(0);

  await signInDashboard(context, shop.s);
  await openExpenses(page);
  const dl = page.waitForEvent('download');
  await exportCsvButton(page).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe(`expenses-${slug}-${shop.month}.csv`);
});

test('audit (S151): created / updated with changes / deleted with snapshot / exported / recurrence_started', async () => {
  const audit = await api(shop.s, 'GET', '/audit-logs?per_page=100');
  expect(audit.status).toBe(200);
  const rows = audit.json.data as Json[];
  const of = (action: string) => rows.filter((a) => a.action === action);
  expect(of('expense.created').length).toBeGreaterThanOrEqual(3);
  expect(of('expense.recurrence_started').length).toBeGreaterThanOrEqual(1);
  expect(of('expense.exported').length).toBeGreaterThanOrEqual(1);
  const upd = of('expense.updated').find((a) => JSON.stringify(a.meta ?? a).includes('150000'));
  expect(upd, 'update audit carries amount [old, new]').toBeTruthy();
  expect(JSON.stringify(upd)).toContain('200000');
  const del = of('expense.deleted')[0];
  expect(del, 'delete audit').toBeTruthy();
  expect(JSON.stringify(del)).toContain('ads');
  await deleteExpense(shop.s, ids.formula);
});
