import { expect, test } from '@playwright/test';
import { api } from '../support/api';
import {
  canvasJpeg,
  createExpense,
  expenseShop,
  listExpenses,
  moveNextOn,
  nextMonthStart,
  patchExpense,
  profit,
  receiptLink,
  recurrence,
  runRepeat,
  uploadReceipt,
  type ExpenseShop,
} from '../support/expenses';

/**
 * PHASE-8-7 §13 QA "Repeat every month" + AC 5 (P87-9, §6.2, S149): a back-dated series starts next month (no
 * catch-up); with the clock moved one month (`next_on` → today, test-only) `expenses:repeat` creates exactly one
 * occurrence that copies the latest occurrence (category, paid from, amount, note) with no receipt and `created_by`
 * null, audited as `expense.repeated` by `system`; a second run adds nothing; P&L picks the occurrence up; turning the
 * toggle off on an occurrence stops the series (no further rows). Needs a worker on `default` (the generation job).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.describe.configure({ mode: 'serial' });

let shop: ExpenseShop;
let first: Json;
let occurrence: Json | undefined;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await expenseShop('exm', 'growth');
});
test.afterAll(() => shop?.cleanup());

async function occurrences(recurrenceId: string): Promise<Json[]> {
  const rows = [...(await listExpenses(shop.s, shop.prevMonth)), ...(await listExpenses(shop.s, shop.month))];
  return rows.filter((e) => e.recurrence_id === recurrenceId);
}

test('back-dated start (1st of last month) with a receipt: series active, next_on = 1st of next month (no catch-up)', async ({ browser }) => {
  const receipt = await uploadReceipt(shop.s, { name: 'qa-salary.jpg', mimeType: 'image/jpeg', buffer: await canvasJpeg(browser, 300, 300) });
  first = await createExpense(shop.s, {
    amount: 2500000,
    category: 'salaries',
    paid_from: 'bkash',
    spent_on: shop.prevStart,
    note: 'QA helper salary',
    receipt_id: receipt.id,
    repeat_monthly: true,
  });
  expect(first).toMatchObject({ repeat_monthly: true, spent_on: shop.prevStart });
  await receiptLink(shop.s, first.id); // processed before the generator copies the row
  const rec = recurrence(first.recurrence_id);
  expect(rec).toMatchObject({ status: 'active', day_of_month: 1 });
  expect(String(rec!.next_on).slice(0, 10)).toBe(nextMonthStart(shop.monthStart));
  runRepeat();
  await new Promise((r) => setTimeout(r, 3_000));
  expect(await occurrences(first.recurrence_id), 'nothing due yet: no catch-up for a back-dated start').toHaveLength(1);
});

test('clock moved one month → one occurrence on next_on, copied from the latest, no receipt, created_by null (S149)', async () => {
  test.setTimeout(120_000);
  // edit the latest occurrence first: the edit carries forward (P87-9 "copies the latest")
  await patchExpense(shop.s, first.id, { amount: 2600000 });
  const before = (await profit(shop.s, shop.monthStart, shop.today)).summary as Json;
  moveNextOn(first.recurrence_id, shop.today);
  runRepeat();
  await expect
    .poll(async () => (await occurrences(first.recurrence_id)).length, { timeout: 60_000, intervals: [1_000, 2_000], message: 'generated occurrence (worker on the default queue?)' })
    .toBe(2);
  occurrence = (await occurrences(first.recurrence_id)).find((e) => e.id !== first.id);
  expect(occurrence).toMatchObject({
    category: 'salaries',
    paid_from: 'bkash',
    amount: 2600000,
    note: 'QA helper salary',
    spent_on: shop.today,
    receipt: null,
    created_by: null,
    repeat_monthly: true,
  });
  const rec = recurrence(first.recurrence_id);
  expect(rec!.status).toBe('active');
  expect(String(rec!.next_on).slice(0, 10) > shop.today, 'next_on advanced past today').toBe(true);

  // idempotent: a second run (and the same date again) adds nothing
  moveNextOn(first.recurrence_id, shop.today);
  runRepeat();
  await new Promise((r) => setTimeout(r, 4_000));
  expect(await occurrences(first.recurrence_id)).toHaveLength(2);

  // P&L picks the occurrence up (cache token bumped by the generator)
  const after = (await profit(shop.s, shop.monthStart, shop.today)).summary as Json;
  expect(after.other_expenses_amount - before.other_expenses_amount).toBe(2600000);
  expect(after.net_profit_amount).toBe(before.net_profit_amount - 2600000);

  const audit = await api(shop.s, 'GET', '/audit-logs?per_page=100');
  const repeated = (audit.json.data as Json[]).filter((a) => a.action === 'expense.repeated');
  expect(repeated.length, 'expense.repeated audit').toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(repeated[0]), 'actor system').toMatch(/system/);
});

test('moving an occurrence onto another occurrence\'s date → 422 on spent_on, never 500 (§6.1)', async () => {
  const r = await api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/expenses/${occurrence!.id}`, { spent_on: shop.prevStart });
  expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([422, 'validation_failed']);
  expect(JSON.stringify(r.json.error?.details)).toContain('spent_on');
});

test('toggle off on an occurrence stops the series; the generator adds nothing more (P87-9)', async () => {
  test.setTimeout(90_000);
  const off = await patchExpense(shop.s, occurrence!.id, { repeat_monthly: false });
  expect(off.repeat_monthly).toBe(false);
  expect(recurrence(first.recurrence_id)!.status).toBe('stopped');
  moveNextOn(first.recurrence_id, shop.today);
  runRepeat();
  await new Promise((r) => setTimeout(r, 4_000));
  const rows = await occurrences(first.recurrence_id);
  expect(rows).toHaveLength(2);
  expect(rows.every((e) => e.repeat_monthly === false), 'past rows stay, none repeats').toBe(true);
  const audit = await api(shop.s, 'GET', '/audit-logs?per_page=100');
  expect((audit.json.data as Json[]).some((a) => a.action === 'expense.recurrence_stopped')).toBe(true);
});
