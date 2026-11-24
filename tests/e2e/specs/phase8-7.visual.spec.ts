import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { deliveredOrder } from '../support/automations';
import {
  addExpenseButton,
  canvasJpeg,
  createExpense,
  expenseCard,
  expenseShop,
  monthName,
  mUrl,
  openExpenses,
  tile,
  uploadReceipt,
  type ExpenseShop,
} from '../support/expenses';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-7 §13 QA visual + AC 7 / Q180: Expenses `144:41614` (list; add card open) and the Profit & loss tab `60:12264`
 * with expenses at 1280, 390 and 375 px: no horizontal page overflow, no console errors, documented omissions absent
 * ("Facebook ads" → "Ads", Target 25 %, Schedule email, P&L "Export CSV · PDF", "Coming with Expenses"), composed items
 * present (Courier/Other chips, "before expenses" line, Ad spend + Other expenses rows). Screenshots →
 * test-results/phase8-7-visual/<width>/ (git-ignored) for the Figma review.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-7-visual');
const WIDTHS = [1280, 390, 375];

let shop: ExpenseShop;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  shop = await expenseShop('exv', 'growth');
  await deliveredOrder(shop);
  const receipt = await uploadReceipt(shop.s, { name: 'qa-visual.jpg', mimeType: 'image/jpeg', buffer: await canvasJpeg(browser) });
  await createExpense(shop.s, { amount: 450000, category: 'ads', paid_from: 'bkash', spent_on: shop.today, note: 'Facebook boost — Eid collection', receipt_id: receipt.id });
  await createExpense(shop.s, { amount: 1200000, category: 'rent_bills', paid_from: 'bank', spent_on: shop.monthStart, note: 'Shop rent', repeat_monthly: true });
  await createExpense(shop.s, { amount: 85000, category: 'packaging', paid_from: 'cash', spent_on: shop.today, note: 'Poly mailers ×200' });
  await createExpense(shop.s, { amount: 30000, category: 'courier', paid_from: 'cash', spent_on: shop.today, note: 'Pickup charge (not on invoice)' });
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

const OMITTED = [/Facebook ads/, /Target 25/, /Schedule email/, /Export CSV · PDF/, /Coming with Expenses/, /Money & COD/];

for (const width of WIDTHS) {
  test(`Expenses + Profit tab at ${width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(120_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await openExpenses(page);
    await expect(page.getByText('Shop rent').first()).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, `Spent in ${monthName(shop.month)}`)).toBeVisible();
    await expect(tile(page, 'Profit after expenses')).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'expenses-list', overflow);

    await addExpenseButton(page).click();
    await expect(expenseCard(page, /^Add expense$/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/JPG, PNG, WebP or PDF · up to 5 MB/).first()).toBeVisible();
    await shot(page, width, 'expenses-add-card', overflow);

    await page.goto(mUrl(`/reports/profit?from=${shop.monthStart}&to=${shop.today}`));
    await expect(page.getByText(/Other expenses/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/before expenses/).first()).toBeVisible();
    for (const hidden of OMITTED) await expect(page.getByText(hidden), `omitted: ${hidden}`).toHaveCount(0);
    await shot(page, width, 'profit', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}
