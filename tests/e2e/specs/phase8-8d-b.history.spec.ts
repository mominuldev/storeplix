import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { randomPhone } from '../support/commerce';
import { mUrl } from '../support/locations';
import { watchConsole } from '../support/roles';
import {
  cashSale,
  createRegisterRaw,
  historyUrl,
  ok,
  openSession,
  posShop,
  posSmsRows,
  printCount,
  quote,
  returnByVariant,
  saleRaw,
  salesList,
  salesListRaw,
  stubPrint,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part B sales history (§9, §11.7; §16 AC 7), real stack. Two registers; today's till sales: R1 cash ৳ 1,000,
 * bKash ৳ 1,200 (customer phone), split ৳ 500; R2 card ৳ 1,400; then a ৳ 500 cash refund on the cash sale.
 *  - API KPIs: sales = Σ totals − Σ refunds, receipts, average (rounded), returns count + amount; filters register,
 *    method (split), q (exact number / phone, all days), date yesterday empty, custom > 366 days → 422; page size 50.
 *  - UI: KPI tiles match; filters drive the URL and the table; empty state; detail pill / lines / Cash received / Change
 *    given; Reprint calls window.print; Send SMS queues a `pos_receipt` to the sale's phone.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let s1: Json;
let s2: Json;
let r2: Json;
const sales: Record<string, Json> = {};
const phone = randomPhone();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('phis', 'growth', { online: 10, atShop: 8 });
  r2 = await ok(await createRegisterRaw(shop.s, { name: 'Register 2', location_id: shop.shop.id }), 201, 'register 2');
  s1 = await openSession(shop.s, shop.register.id, { opening_cash_amount: 100000 });
  s2 = await openSession(shop.s, r2.id, { opening_cash_amount: 0 });
  sales.cash = await cashSale(shop.s, s1.id, [{ variant_id: shop.wrap, quantity: 2 }], { tendered_cash_amount: 150000 });
  const qM = await quote(shop.s, s1.id, [{ variant_id: shop.kurtaM, quantity: 1 }]);
  sales.bkash = await ok(await saleRaw(shop.s, { session_id: s1.id, lines: [{ variant_id: shop.kurtaM, quantity: 1 }], customer: { phone, name: 'QA History Buyer' }, expected_total_amount: qM.total_amount, payments: [{ method: 'bkash_personal', amount: qM.total_amount }], sms_receipt: false }), 201, 'bkash');
  sales.split = await ok(await saleRaw(shop.s, { session_id: s1.id, lines: [{ variant_id: shop.wrap, quantity: 1 }], expected_total_amount: 50000, payments: [{ method: 'cash', amount: 20000 }, { method: 'card', amount: 30000 }], tendered_cash_amount: 20000, sms_receipt: false }), 201, 'split');
  sales.card = await ok(await saleRaw(shop.s, { session_id: s2.id, lines: [{ variant_id: shop.kurtaL, quantity: 1 }], expected_total_amount: 140000, payments: [{ method: 'card', amount: 140000 }], sms_receipt: false }), 201, 'card');
  const ret = await returnByVariant(shop.s, sales.cash, s1.id, [[shop.wrap, 1]], 'cash');
  expect(ret.status, ret.text.slice(0, 200)).toBe(201);
});
test.afterAll(() => shop?.cleanup());

test('API: KPIs and filters', async () => {
  const all = await salesList(shop.s);
  expect(all.data).toHaveLength(4);
  expect(all.meta.per_page).toBe(50);
  // 4 receipts, ৳ 4,100 sold − ৳ 500 refunded = ৳ 3,600; average = round(3600 / 4) = ৳ 900.
  expect(all.meta.summary).toEqual({ sales_amount: 360000, receipts_count: 4, average_sale_amount: 90000, returns_count: 1, returns_amount: 50000 });
  expect(all.data.find((x) => x.id === sales.cash.id)).toMatchObject({ refunded_amount: 50000, paid_by: 'cash', register_name: 'Register 1' });

  const reg2 = await salesList(shop.s, `filter[register_id]=${r2.id}`);
  expect(reg2.data.map((x) => x.number)).toEqual([sales.card.number]);
  expect(reg2.meta.summary).toMatchObject({ sales_amount: 140000, receipts_count: 1 });
  expect((await salesList(shop.s, 'filter[method]=split')).data.map((x) => x.number)).toEqual([sales.split.number]);
  expect((await salesList(shop.s, `q=${sales.bkash.number}`)).data.map((x) => x.id)).toEqual([sales.bkash.id]);
  expect((await salesList(shop.s, `q=${phone}`)).data.map((x) => x.id), 'phone search, local format').toEqual([sales.bkash.id]);
  expect((await salesList(shop.s, `q=${sales.bkash.number.slice(0, -1)}`)).data, 'exact only').toEqual([]);
  const y = await salesList(shop.s, 'filter[date]=yesterday');
  expect(y.data).toEqual([]);
  expect(y.meta.summary).toMatchObject({ sales_amount: 0, receipts_count: 0 });
  const tooLong = await salesListRaw(shop.s, 'filter[date]=custom&from=2025-01-01&to=2026-11-25');
  expect(tooLong.status, 'custom range > 366 days').toBe(422);
});

test('UI: KPIs, filters, empty state, detail, reprint, send SMS', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(historyUrl(s1.id)));
  const kpis = page.getByTestId('pos-history-kpis');
  // Default: the session's register (header "{register} · {location} · Today"): 3 receipts, ৳ 2,700 − ৳ 500.
  await expect(kpis).toContainText('Sales today', { timeout: 20_000 });
  await expect(page.getByTestId('pos-bar-subtitle')).toContainText('Register 1 · Mirpur shop · Today');
  await expect(kpis).toContainText('৳ 2,200');
  await expect(kpis).toContainText('৳ 733.33');
  await expect(kpis).toContainText('1 · ৳ 500');
  await expect(page.getByTestId('pos-history-row')).toHaveCount(3);
  await expect(page.getByTestId('pos-history-row').filter({ hasText: sales.cash.number })).toContainText('Return');
  await expect(page.getByTestId('pos-history-row').filter({ hasText: sales.bkash.number })).toContainText('QA History Buyer');

  await page.getByTestId('pos-history-register').selectOption({ label: 'All registers' });
  await expect(page).toHaveURL(/register=all/);
  await expect(page.getByTestId('pos-history-row')).toHaveCount(4);
  await expect(kpis).toContainText('৳ 3,600');
  await expect(kpis).toContainText('৳ 900');
  await page.getByTestId('pos-history-register').selectOption({ label: 'Register 2 · Mirpur shop' });
  await expect(page).toHaveURL(new RegExp(`register=${r2.id}`));
  await expect(page.getByTestId('pos-history-row')).toHaveCount(1);
  await expect(kpis).toContainText('৳ 1,400');
  await page.getByTestId('pos-history-register').selectOption({ label: 'All registers' });
  await page.getByTestId('pos-history-method').selectOption({ label: 'Split' });
  await expect(page).toHaveURL(/method=split/);
  await expect(page.getByTestId('pos-history-row')).toHaveCount(1);
  await expect(page.getByTestId('pos-history-row')).toContainText(sales.split.number);
  await page.getByTestId('pos-history-method').selectOption({ label: 'All methods' });
  await page.getByTestId('pos-history-search').fill(sales.bkash.number);
  await expect(page.getByTestId('pos-history-row')).toHaveCount(1);
  await page.getByTestId('pos-history-search').fill('');
  await page.getByTestId('pos-history-date').selectOption({ label: 'Yesterday' });
  await expect(page).toHaveURL(/date=yesterday/);
  await expect(page.getByText('No sales match these filters')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await page.getByTestId('pos-history-date').selectOption({ label: 'Today' });
  await expect(page.getByTestId('pos-history-row')).toHaveCount(4);

  // Detail of the cash sale: Cash received / Change given / Refunded.
  await page.getByTestId('pos-history-row').filter({ hasText: sales.cash.number }).click();
  const detail = page.getByTestId('pos-sale-detail');
  await expect(detail).toContainText(`Receipt ${sales.cash.number}`);
  await expect(detail.getByTestId('pos-sale-pill')).toHaveText('Partly refunded');
  await expect(detail).toContainText('Cash received');
  await expect(detail).toContainText('৳ 1,500');
  await expect(detail).toContainText('Change given');
  await expect(detail).toContainText('− ৳ 500');
  await expect(detail.getByTestId('pos-send-sms'), 'walk-in: no SMS').toBeDisabled();
  await detail.getByTestId('pos-reprint').click();
  await expect.poll(() => printCount(page)).toBe(1);

  // The phone sale: Send SMS → one pos_receipt to its phone.
  await page.getByTestId('pos-history-row').filter({ hasText: sales.bkash.number }).click();
  await expect(detail).toContainText(`Receipt ${sales.bkash.number}`);
  const sms = page.waitForResponse((r) => r.request().method() === 'POST' && /\/sms-receipt$/.test(new URL(r.url()).pathname));
  await detail.getByTestId('pos-send-sms').click();
  expect((await sms).status()).toBe(200);
  await expect.poll(() => posSmsRows(shop.s.tenantId).length, { timeout: 20_000 }).toBe(1);
  expect(posSmsRows(shop.s.tenantId)[0]).toMatchObject({ to: `88${phone}` });
  await expect(detail.getByText('Void receipt')).toHaveCount(0);

  await page.getByTestId('pos-back-to-sale').click();
  await expect(page).toHaveURL(new RegExp(`/pos/${s1.id}$`));
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
