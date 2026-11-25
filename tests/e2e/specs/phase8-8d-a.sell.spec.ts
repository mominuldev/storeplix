import { expect, test } from '@playwright/test';
import { randomPhone } from '../support/commerce';
import { signInDashboard } from '../support/api';
import { stockAt, movementsWhere } from '../support/locations';
import { watchConsole, watchApiErrors } from '../support/roles';
import {
  bdt,
  cart,
  chargeTotal,
  closeRaw,
  countsFor,
  createRegisterRaw,
  customerLookupRaw,
  gotoPos,
  idem,
  KURTA,
  MIRPUR,
  logMark,
  ok,
  openRaw,
  orderDetail,
  paymentDialog,
  posShop,
  posSmsRows,
  printCount,
  quote,
  saleComplete,
  saleGetRaw,
  saleResponse,
  serverErrorsSince,
  session,
  setCount,
  stubPrint,
  tile,
  TOLERANCE,
  unexpectedApiErrors,
  WRAP,
  WRAP_PRICE,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part A, the till end to end on the real stack (§4–§7, §11.1–§11.5, §11.8; §16 AC 2, 4, 5, 6; S200, S201,
 * S204). One Growth shop: Main warehouse (online) 10 per variant, Mirpur shop 5 per variant, Register 1 at Mirpur shop.
 *  (a) API contract: open needs an Idempotency-Key (400), replays the first session with the same key, refuses a second
 *      open (409 `register_already_open` + details.session_id); shapes match `packages/types`.
 *  (b) UI: open Register 1 with counted notes (৳ 2,000) → sell Wrap × 2 for cash with change (৳ 1,500 → ৳ 500 change),
 *      print called once, stock leaves Mirpur only → Kurta M by variant picker to a new phone with bKash TrxID and SMS
 *      receipt (fake driver row `pos_receipt` to 8801…) → walk-in card with approval code (SMS tick disabled) → split
 *      cash + bKash. Every sale is a delivered, paid `pos` order with one payment row per part bound to the session.
 *  (c) Close ৳ 20 short within tolerance with a note → Last session card; re-open (prefilled from "left in drawer") and
 *      close ৳ 100 over → note required (UI + 422 `close_note_required`).
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: PosShop;
let sessionId = '';
const sales: Json[] = [];
const newPhone = randomPhone();

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await posShop('psell', 'growth', { online: 10, atShop: 5 });
});
test.afterAll(() => shop?.cleanup());

const keysOf = (o: Json) => Object.keys(o).sort();

test('(a) API contract: open idempotency, already open, shapes', async () => {
  const s = shop.s;
  const r2 = await ok(await createRegisterRaw(s, { name: 'Register 2', location_id: shop.main.id }), 201, 'register 2');
  expect(keysOf(r2)).toEqual(['archived_at', 'id', 'last_session', 'location', 'name', 'open_session', 'position']);
  expect(r2.location).toMatchObject({ id: shop.main.id, type: expect.any(String) });

  const none = await openRaw(s, r2.id, { opening_cash_amount: 100000 }, s, null);
  expect([none.status, none.json.error?.code], none.text.slice(0, 200)).toEqual([400, 'idempotency_key_required']);

  const key = idem();
  const first = await ok(await openRaw(s, r2.id, { counts: { '100000': 1, '5000': 2 } }, s, key), 201, 'open with counts');
  expect(first.opening_cash_amount, 'counts win: Σ = ৳ 1,100').toBe(110000);
  const replay = await openRaw(s, r2.id, { counts: { '100000': 1, '5000': 2 } }, s, key);
  expect([replay.status, replay.json.data?.id], 'same key + body replays the first session (S200)').toEqual([201, first.id]);
  const again = await openRaw(s, r2.id, { opening_cash_amount: 0 });
  expect([again.status, again.json.error?.code, again.json.error?.details?.session_id]).toEqual([409, 'register_already_open', first.id]);
  const mismatch = await openRaw(s, r2.id, { opening_cash_amount: 5 }, s, key);
  expect([mismatch.status, mismatch.json.error?.code], 'same key, other body').toEqual([409, 'idempotency_key_mismatch']);

  for (const k of ['id', 'register', 'status', 'currency', 'opened_at', 'opened_by', 'opening_cash_amount', 'opening_counts', 'closed_at', 'closed_by', 'counted_cash_amount', 'closing_counts', 'expected_cash_amount', 'variance_amount', 'left_in_drawer_amount', 'banked_amount', 'close_note', 'tolerance_amount', 'last_closing_left_amount', 'totals', 'revision'])
    expect(first, `PosSession.${k}`).toHaveProperty(k);
  expect(first.tolerance_amount).toBe(TOLERANCE);
  for (const k of ['cash_in_drawer_amount', 'cash_sales_amount', 'cash_refunds_amount', 'sales_amount', 'receipts_count', 'by_method', 'returns_count', 'returns_amount', 'discounts_amount', 'held_sales_count'])
    expect(first.totals, `PosSessionTotals.${k}`).toHaveProperty(k);
  expect(first.register.location).toMatchObject({ id: shop.main.id });

  const q = await quote(s, first.id, [{ variant_id: shop.wrap, quantity: 2 }]);
  for (const k of ['currency', 'lines', 'items_count', 'subtotal_amount', 'discount_amount', 'coupon_code', 'vat', 'total_amount']) expect(q, `PosQuote.${k}`).toHaveProperty(k);
  expect(q.lines[0]).toMatchObject({ variant_id: shop.wrap, quantity: 2, unit_price_amount: WRAP_PRICE, line_total_amount: 2 * WRAP_PRICE, available: 10, problem: null });
  expect(q.total_amount).toBe(2 * WRAP_PRICE);

  // Close the API register again so the UI starts from a clean picker (Register 1 chosen first: no open session).
  const closed = await ok(await closeRaw(s, first.id, { counted_cash_amount: 110000, left_in_drawer_amount: 0, revision: first.revision }), 200, 'close register 2');
  expect(closed).toMatchObject({ status: 'closed', expected_cash_amount: 110000, variance_amount: 0, banked_amount: 110000, left_in_drawer_amount: 0 });
});

test('(b) open with counts, sell cash/bKash/card/split, receipt, print, SMS', async ({ page, context }) => {
  test.setTimeout(240_000);
  const c = watchConsole(page);
  const apiErrors = watchApiErrors(page);
  const mark = logMark();
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await gotoPos(page);

  // ---- Open register (25:581) ----
  await expect(page.getByRole('heading', { name: 'Open register' })).toBeVisible();
  const select = page.getByTestId('pos-register-select');
  await select.selectOption({ label: `Register 1 · ${MIRPUR}` });
  await expect(page.getByTestId('pos-cashier')).not.toHaveValue('');
  await setCount(page, 100000, 1);
  await setCount(page, 50000, 2);
  await expect(page.getByTestId('pos-opening-total')).toHaveText('৳ 2,000');
  const opened = page.waitForResponse((r) => r.request().method() === 'POST' && /\/pos\/registers\/[0-9A-Z]{26}\/open$/i.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-open-submit').click();
  const or = await opened;
  expect(or.status(), await or.text()).toBe(201);
  expect(or.request().headers()['idempotency-key'], 'open carries an Idempotency-Key').toBeTruthy();
  expect(JSON.parse(or.request().postData() ?? '{}')).toEqual({ counts: { '100000': 1, '50000': 2 } });
  await page.waitForURL(/\/pos\/[0-9A-Za-z]{26}$/);
  sessionId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('pos-bar-subtitle')).toContainText(`Register 1 · ${MIRPUR} · Opened`);
  await expect(page.getByTestId('pos-cash-in-drawer')).toHaveText('৳ 2,000');
  await expect(page.getByTestId('pos-online-pill')).toHaveText(/Online/);

  // ---- Sale 1: Wrap × 2, cash ৳ 1,500 → change ৳ 500 ----
  await expect(tile(page, WRAP)).toContainText('5 in stock');
  await tile(page, WRAP).click();
  await tile(page, WRAP).click();
  await expect(cart(page).getByTestId('pos-line-qty')).toHaveText('2');
  expect(await chargeTotal(page)).toBe(2 * WRAP_PRICE);
  await cart(page).getByTestId('pos-charge').click();
  const pay = paymentDialog(page);
  await expect(pay).toBeVisible();
  await expect(pay.getByTestId('pos-amount-to-pay')).toHaveText('৳ 1,000');
  await pay.getByTestId('pos-cash-received').fill('1500');
  await expect(pay.getByTestId('pos-change')).toContainText('৳ 500');
  await expect(pay.getByRole('checkbox', { name: 'Print receipt' })).toBeChecked();
  await expect(pay.getByRole('checkbox', { name: 'SMS receipt' }), 'walk-in → SMS tick disabled').toBeDisabled();
  const s1 = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(s1.status, JSON.stringify(s1.body).slice(0, 400)).toBe(201);
  expect(s1.key, 'sale carries an Idempotency-Key').toBeTruthy();
  sales.push(s1.body.data);
  const done = saleComplete(page);
  await expect(done).toBeVisible();
  await expect(done.getByTestId('pos-receipt-number')).toHaveText(`Receipt ${s1.body.data.number} · paid in cash`);
  await expect(done.getByTestId('pos-give-change')).toContainText('৳ 500');
  await expect(done.getByTestId('pos-sms-row')).toContainText(/No phone|not sent/);
  await expect.poll(() => printCount(page), { message: 'window.print called once on complete (Print receipt ticked)' }).toBe(1);
  await expect(done.getByText('Printed on 80 mm printer')).toBeVisible();
  // Receipt preview (P88D-11): shop, number, lines, total, tendered, change.
  const receipt = page.getByTestId('pos-receipt').filter({ visible: true }).first();
  await expect(receipt).toContainText(s1.body.data.number);
  await expect(receipt).toContainText(WRAP);
  await expect(receipt).toContainText('1,000');
  await expect(receipt).toContainText('1,500');
  await expect(receipt).toContainText('500');
  expect(s1.body.data).toMatchObject({ tendered_cash_amount: 150000, change_amount: 50000, total_amount: 100000, paid_by: 'cash', sms_receipt_status: 'no_phone' });
  await done.getByTestId('pos-new-sale').click();
  await expect(done).toBeHidden();
  await expect(page.getByTestId('pos-cash-in-drawer')).toHaveText('৳ 3,000');

  // Stock left Mirpur shop only (P88D-6): 5 → 3; Main (online) unchanged at 10; ledger `pos_sale` −2 at Mirpur.
  expect(await stockAt(shop.s, shop.wrap, shop.shop.id)).toMatchObject({ on_hand: 3, available: 3 });
  expect(await stockAt(shop.s, shop.wrap, shop.main.id)).toMatchObject({ on_hand: 10 });
  const ledger = await movementsWhere(shop.s, { reason: 'pos_sale' });
  const l1 = ledger.filter((m) => (m.variant?.id ?? m.variant_id) === shop.wrap);
  expect(l1.map((m) => [m.delta ?? m.quantity, m.location?.id ?? m.location_id])).toEqual([[-2, shop.shop.id]]);
  await expect(tile(page, WRAP)).toContainText('3 in stock');

  // ---- Sale 2: Kurta M via the variant picker, new customer by phone, bKash with TrxID, SMS receipt ----
  await tile(page, KURTA).click();
  const picker = page.getByRole('dialog', { name: 'Choose options' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /^M/ }).click();
  await expect(picker.getByTestId('pos-picker-add')).toHaveText('Add to sale · ৳ 1,200');
  await picker.getByTestId('pos-picker-add').click();
  await expect(picker).toBeHidden();
  await cart(page).getByRole('button', { name: 'Add customer' }).click();
  await cart(page).getByLabel('Customer phone').fill(newPhone);
  const nameBox = cart(page).getByLabel('New customer name');
  await expect(nameBox, 'unknown phone → new customer name box').toBeVisible({ timeout: 15_000 });
  await nameBox.fill('QA Walkin Rahim');
  await cart(page).getByRole('radio', { name: 'bKash' }).click();
  expect(await chargeTotal(page)).toBe(120000);
  await cart(page).getByTestId('pos-charge').click();
  await expect(pay).toBeVisible();
  await expect(pay.getByRole('radio', { name: /bKash/ })).toHaveAttribute('aria-checked', 'true');
  await pay.getByTestId('pos-reference').fill('TRX8D0001');
  await expect(pay.getByRole('checkbox', { name: 'SMS receipt' }), 'phone → SMS receipt on by default').toBeChecked();
  const s2 = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(s2.status, JSON.stringify(s2.body).slice(0, 400)).toBe(201);
  sales.push(s2.body.data);
  expect(s2.body.data.paid_by).toBe('bkash_personal');
  expect(['queued', 'sent'], `sms_receipt_status ${s2.body.data.sms_receipt_status}`).toContain(s2.body.data.sms_receipt_status);
  await expect(done.getByTestId('pos-receipt-number')).toHaveText(`Receipt ${s2.body.data.number} · paid in bKash`);
  await expect(done.getByTestId('pos-give-change')).toHaveCount(0);
  await expect(done.getByTestId('pos-sms-row')).toContainText(/SMS receipt (sent )?to|Sending SMS receipt to/);
  await expect.poll(() => printCount(page)).toBe(2);
  await done.getByTestId('pos-new-sale').click();

  // ---- Sale 3: walk-in, card with approval code, Print receipt unticked ----
  await tile(page, WRAP).click();
  await cart(page).getByRole('radio', { name: 'Card' }).click();
  await cart(page).getByTestId('pos-charge').click();
  await pay.getByTestId('pos-reference').fill('APPR-77');
  await pay.getByRole('checkbox', { name: 'Print receipt' }).uncheck();
  const s3 = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(s3.status, JSON.stringify(s3.body).slice(0, 400)).toBe(201);
  sales.push(s3.body.data);
  await expect(done.getByTestId('pos-receipt-number')).toHaveText(`Receipt ${s3.body.data.number} · paid in card`);
  await expect(done.getByText('Not printed')).toBeVisible();
  expect(await printCount(page), 'unticked → no print').toBe(2);
  await done.getByTestId('pos-new-sale').click();

  // ---- Sale 4: split cash ৳ 200 + bKash rest ৳ 300 ----
  await tile(page, WRAP).click();
  await cart(page).getByRole('radio', { name: 'Split' }).click();
  await cart(page).getByTestId('pos-charge').click();
  const split = pay.getByTestId('pos-split');
  await expect(split).toBeVisible();
  await split.getByLabel('Part 1 amount').fill('200');
  await expect(pay.getByTestId('pos-split-remaining')).toHaveText('Remaining ৳ 300');
  await split.getByRole('button', { name: 'Rest' }).click();
  await expect(pay.getByTestId('pos-split-remaining')).toHaveText('Fully paid');
  await split.getByLabel('Part 2 reference').fill('TRX8D0002');
  const s4 = await saleResponse(page, () => pay.getByTestId('pos-complete-sale').click());
  expect(s4.status, JSON.stringify(s4.body).slice(0, 400)).toBe(201);
  sales.push(s4.body.data);
  await expect(done.getByTestId('pos-receipt-number')).toHaveText(`Receipt ${s4.body.data.number} · paid in split`);
  await done.getByTestId('pos-new-sale').click();
  await expect(page.getByTestId('pos-cash-in-drawer')).toHaveText('৳ 3,200');

  // An unknown phone is a 404 by design (§5.3: new customer); nothing else may fail.
  const unexpected = unexpectedApiErrors(apiErrors, [/\/pos\/customers\/lookup\?phone=\d+ → 404$/]);
  expect(unexpected, unexpected.join('\n')).toEqual([]);
  expect(serverErrorsSince(mark), 'no server errors other than the sqlite lock flake').toEqual([]);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(b) API: every sale is a delivered, paid pos order with session-bound payment rows; SMS receipt row', async () => {
  expect(sales).toHaveLength(4);
  const want: Array<Array<[string, number, string | null]>> = [
    [['cash', 100000, null]],
    [['bkash_personal', 120000, 'TRX8D0001']],
    [['card', 50000, 'APPR-77']],
    [['cash', 20000, null], ['bkash_personal', 30000, 'TRX8D0002']],
  ];
  for (const [i, sale] of sales.entries()) {
    const full = await ok(await saleGetRaw(shop.s, sale.id), 200, `sale ${i}`);
    expect(full.session_id).toBe(sessionId);
    expect(full.receipt.number).toBe(full.number);
    const o = await orderDetail(shop.s, full.order_id);
    expect(o, `order ${o.number}`).toMatchObject({ number: full.number, created_via: 'pos', channel: 'walk_in', status: 'delivered', payment_status: 'paid', payment_method: 'pos' });
    expect(o.paid_amount ?? o.total_amount).toBe(o.total_amount);
    expect(o.pos).toMatchObject({ register_name: 'Register 1' });
    const pays = ((o.payments ?? []) as Json[]).filter((p) => p.type === 'charge');
    expect(
      pays.map((p) => [p.method, p.amount, p.reference ?? null]).sort(),
      `payment rows of ${o.number}`,
    ).toEqual([...want[i]!].sort());
    for (const p of pays) expect(p).toMatchObject({ provider: 'manual', status: 'succeeded', pos_session_id: sessionId });
  }
  const o1 = await orderDetail(shop.s, sales[0].order_id);
  expect(o1.customer, 'walk-in sentinel customer (P88D-10)').toMatchObject({ name: 'Walk-in customer', phone: '' });
  expect(o1.shipment).toBeNull();
  // Sale 2 created the customer; phones come back as 8801…
  const o2 = await orderDetail(shop.s, sales[1].order_id);
  expect(o2.customer).toMatchObject({ name: 'QA Walkin Rahim', phone: `88${newPhone}` });
  const found = await customerLookupRaw(shop.s, newPhone);
  expect(found.status, found.text.slice(0, 200)).toBe(200);
  expect(found.json.data).toMatchObject({ name: 'QA Walkin Rahim', orders_count: 1, total_spent_amount: 120000 });
  // Fake SMS driver: exactly one pos_receipt to the sale's phone (S204); no order-status SMS for till sales (P88D-13).
  await expect.poll(() => posSmsRows(shop.s.tenantId).length, { timeout: 20_000 }).toBe(1);
  expect(posSmsRows(shop.s.tenantId)[0]).toMatchObject({ to: `88${newPhone}` });

  const sess = await session(shop.s, sessionId);
  expect(sess.totals).toMatchObject({ cash_in_drawer_amount: 320000, cash_sales_amount: 120000, receipts_count: 4, sales_amount: 320000 });
  const byMethod = Object.fromEntries((sess.totals.by_method as Json[]).map((m) => [m.method, m.amount]));
  expect(byMethod).toMatchObject({ cash: 120000, bkash_personal: 150000, card: 50000 });
});

test('(c) close ৳ 20 short with a note → Last session card; re-open prefilled; ৳ 100 over needs a note', async ({ page, context }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await stubPrint(page);
  await signInDashboard(context, shop.s);
  await gotoPos(page, `/pos/${sessionId}`);
  await page.getByTestId('pos-close-register').click();
  await page.waitForURL(new RegExp(`/pos/${sessionId}/close$`));
  await expect(page.getByRole('heading', { name: 'Close register' })).toBeVisible();
  await expect(page.getByTestId('pos-expected')).toHaveText('৳ 3,200');
  // ৳ 3,180 = 3 × 1,000 + 100 + 50 + 20 + 10 → short ৳ 20 (within ৳ 50)
  for (const [d, n] of Object.entries(countsFor(318000))) await setCount(page, Number(d), n);
  await expect(page.getByTestId('pos-counted')).toHaveText('৳ 3,180');
  await expect(page.getByTestId('pos-variance')).toContainText('Short by ৳ 20');
  await expect(page.getByTestId('pos-variance')).toContainText('Within your ৳ 50 tolerance');
  await expect(page.getByTestId('pos-leave-in-drawer')).toHaveValue('2000');
  await expect(page.getByTestId('pos-banked')).toHaveText('৳ 1,180');
  await page.getByTestId('pos-close-note').fill('Coin given as change twice');
  await page.getByTestId('pos-print-z').click();
  await expect.poll(() => printCount(page), { message: 'Print Z-report calls window.print' }).toBe(1);
  await page.getByTestId('pos-close-submit').click();
  const closing = page.waitForResponse((r) => r.request().method() === 'POST' && /\/pos\/sessions\/[0-9A-Z]{26}\/close$/i.test(new URL(r.url()).pathname));
  await page.getByTestId('pos-close-confirm').click();
  const cr = await closing;
  expect(cr.status(), await cr.text()).toBe(200);
  expect(cr.request().headers()['idempotency-key']).toBeTruthy();
  const closed = (await cr.json()).data as Json;
  expect(closed).toMatchObject({ status: 'closed', expected_cash_amount: 320000, counted_cash_amount: 318000, variance_amount: -2000, left_in_drawer_amount: 200000, banked_amount: 118000, close_note: 'Coin given as change twice' });
  await page.waitForURL(/\/pos$/);

  // Last session card (25:581) for Register 1.
  await page.getByTestId('pos-register-select').selectOption({ label: `Register 1 · ${MIRPUR}` });
  const last = page.getByTestId('pos-last-session');
  await expect(last).toContainText('৳ 3,200 · 4 receipts');
  await expect(last).toContainText('৳ 3,180');
  await expect(last).toContainText('−৳ 20');
  await expect(last).toContainText('৳ 1,180');
  await expect(last).toContainText('৳ 2,000');
  await expect(page.getByTestId('pos-register-list')).toContainText('Closed · ready');
  // Opening prefilled from "left in drawer" (P88D-15) with the "Matches last closing" hint.
  await expect(page.getByTestId('pos-opening-total')).toHaveText('৳ 2,000');
  await expect(page.getByText(/Matches last closing/)).toBeVisible();
  await page.getByTestId('pos-open-submit').click();
  await page.waitForURL(/\/pos\/[0-9A-Za-z]{26}$/);
  const second = new URL(page.url()).pathname.split('/').pop()!;
  expect(second).not.toBe(sessionId);

  // API: ৳ 100 over without a note → 422 close_note_required (details), nothing closed.
  const s2 = await session(shop.s, second);
  const noNote = await closeRaw(shop.s, second, { counted_cash_amount: 210000, left_in_drawer_amount: 0, revision: s2.revision });
  expect([noNote.status, noNote.json.error?.code, noNote.json.error?.details?.variance_amount, noNote.json.error?.details?.tolerance_amount]).toEqual([422, 'close_note_required', 10000, TOLERANCE]);
  const leftTooMuch = await closeRaw(shop.s, second, { counted_cash_amount: 200000, left_in_drawer_amount: 200001, revision: s2.revision });
  expect(leftTooMuch.status, 'left > counted').toBe(422);

  // UI: over tolerance → danger copy, note required, Close disabled until a note is typed.
  await page.getByTestId('pos-close-register').click();
  await setCount(page, 100000, 2);
  await setCount(page, 10000, 1);
  await expect(page.getByTestId('pos-variance')).toContainText('Over by ৳ 100');
  await expect(page.getByTestId('pos-variance')).toContainText('Over your ৳ 50 tolerance — add a note to close.');
  await expect(page.getByTestId('pos-close-submit')).toBeDisabled();
  await page.getByTestId('pos-close-note').fill('Float topped up from the safe');
  await expect(page.getByTestId('pos-close-submit')).toBeEnabled();
  await page.getByTestId('pos-close-submit').click();
  await page.getByTestId('pos-close-confirm').click();
  await page.waitForURL(/\/pos$/);
  expect(await session(shop.s, second)).toMatchObject({ status: 'closed', variance_amount: 10000, close_note: 'Float topped up from the safe' });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
