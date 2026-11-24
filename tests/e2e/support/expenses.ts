import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { api, apiCall, tinker, urls, type ApiResult, type Session } from './api';
import { kpi } from './analytics';
import { addDays, localDate, report } from './billing';
import { setPlan, setupShop, type CommerceShop } from './commerce';

/**
 * Phase 8.7 helpers (PHASE-8-7-CONTRACT §3–§10, §13 QA): expenses API (§8.1), receipts (§5), month summary (§6.3),
 * CSV export (P87-14), the recurrence generator run on demand (`expenses:repeat`, §6.2), Profit & loss additions (§7)
 * and the Expenses UI selectors (one helper per label, so a renamed label is fixed in one place).
 *
 * ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA; fixed at the gate otherwise):
 *  - Expenses page `/reports/expenses` (§10.1): H1 "Expenses"; KPI tiles titled "Spent in {Month}", "Ads",
 *    "Profit after expenses", "Cost per order"; add/edit card titled "Add expense" / "Edit expense" with labelled fields
 *    "Amount", "Category", "Paid from", "Date", "Note", a file input for the receipt and a switch/checkbox
 *    "Repeat every month"; buttons "Save expense", "+ Add expense", "Export CSV", "Delete" (+ a confirm dialog).
 *  - Reports tab bar keeps the 7.x `Tabs aria-label="Reports"`; the new tab is labelled "Expenses".
 *  - Store details Currency select keeps `label="Currency"`; locked caption "Locked after your first order or expense.".
 *  - The month generator dispatches `GenerateRecurringExpenses` on `default` and image receipts are re-encoded by
 *    `ProcessMedia` on `media`: locally a `queue:work` must consume both (compose: `queue`).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const EXPENSES = '/reports/expenses';
export const CATEGORIES = ['ads', 'packaging', 'salaries', 'rent_bills', 'courier', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  ads: 'Ads',
  packaging: 'Packaging',
  salaries: 'Salaries',
  rent_bills: 'Rent & bills',
  courier: 'Courier',
  other: 'Other',
};
export const PAID_FROM = ['cash', 'bank', 'card', 'bkash', 'nagad', 'other'] as const;
export type PaidFrom = (typeof PAID_FROM)[number];
export const COURIER_HINT = /Only charges not already on courier invoices/;
export const CURRENCY_LOCKED_CAPTION = /Locked after your first order or expense\./;
const ULID = /^[0-9a-z]{26}$/i;

// ---------------------------------------------------------------------------------------------
// Shops + dates
// ---------------------------------------------------------------------------------------------

export interface ExpenseShop extends CommerceShop {
  tz: string;
  today: string;
  /** `YYYY-MM` of today in the store tz */
  month: string;
  monthStart: string;
  prevMonth: string;
  prevStart: string;
}

/** Published throwaway shop on `plan` (Asia/Dhaka) with the date anchors every spec needs. Always `cleanup()`. */
export async function expenseShop(label: string, plan: 'free' | 'starter' | 'growth' = 'growth'): Promise<ExpenseShop> {
  const shop = await setupShop(label);
  try {
    setPlan(shop.s, plan);
    const st = await api(shop.s, 'GET', `/stores/${shop.s.storeId}`);
    const tz = (st.json.data?.timezone as string | undefined) ?? 'Asia/Dhaka';
    const today = localDate(new Date(), tz);
    const monthStart = `${today.slice(0, 8)}01`;
    const prevStart = `${addDays(monthStart, -1).slice(0, 8)}01`;
    return { ...shop, tz, today, month: today.slice(0, 7), monthStart, prevMonth: prevStart.slice(0, 7), prevStart };
  } catch (e) {
    shop.cleanup();
    throw e;
  }
}

/** First day of the month after `monthStart` (`YYYY-MM-01`). */
export function nextMonthStart(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** "November" for `2026-11`. */
export function monthName(month: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' }).format(new Date(`${month}-01T00:00:00Z`));
}

// ---------------------------------------------------------------------------------------------
// Expenses API (§8.1)
// ---------------------------------------------------------------------------------------------

export const epath = (s: Session, rest = '') => `/stores/${s.storeId}/expenses${rest}`;

export interface ExpenseInput {
  amount: number;
  category: Category;
  paid_from: PaidFrom;
  spent_on: string;
  note?: string | null;
  receipt_id?: string | null;
  repeat_monthly?: boolean;
}

/** Local sqlite only: a "database is locked" 500 under the workers' writes → retry (nothing committed). */
async function retryLocked(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  let r = await fn();
  for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(r.text); i++) {
    await new Promise((res) => setTimeout(res, 700));
    r = await fn();
  }
  return r;
}

export const createExpenseRaw = (s: Session, input: Partial<ExpenseInput> & Json) => retryLocked(() => apiCall(s, 'POST', epath(s), { json: input }));

export async function createExpense(s: Session, input: ExpenseInput): Promise<Json> {
  const r = await createExpenseRaw(s, input);
  expect(r.status, `POST expense ${JSON.stringify(input)} → ${r.text.slice(0, 400)}`).toBe(201);
  return r.json.data as Json;
}

export const patchExpenseRaw = (s: Session, id: string, change: Json) => retryLocked(() => apiCall(s, 'PATCH', epath(s, `/${id}`), { json: change }));

export async function patchExpense(s: Session, id: string, change: Json): Promise<Json> {
  const r = await patchExpenseRaw(s, id, change);
  expect(r.status, `PATCH expense ${JSON.stringify(change)} → ${r.text.slice(0, 400)}`).toBe(200);
  return r.json.data as Json;
}

export async function deleteExpense(s: Session, id: string): Promise<void> {
  const r = await retryLocked(() => apiCall(s, 'DELETE', epath(s, `/${id}`)));
  expect(r.status, r.text.slice(0, 300)).toBe(204);
}

/** Every expense of `month` (follows the cursor). */
export async function listExpenses(s: Session, month: string, category?: Category): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ 'filter[month]': month });
    if (category) q.set('filter[category]', category);
    if (cursor) q.set('cursor', cursor);
    const r = await retryLocked(() => apiCall(s, 'GET', `${epath(s)}?${q}`));
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    out.push(...(r.json.data as Json[]));
    cursor = (r.json.meta?.next_cursor as string | null | undefined) ?? null;
    if (!cursor) break;
  }
  return out;
}

export async function summary(s: Session, month?: string, as: Session = s): Promise<Json> {
  const r = await retryLocked(() => apiCall(as, 'GET', `${epath(s, '/summary')}${month ? `?month=${month}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json;
}

export const exportCsv = (s: Session, month: string, as: Session = s) =>
  apiCall(as, 'GET', `${epath(s, '/export')}?month=${month}`, { headers: { Accept: 'text/csv, application/json' } });

// ---------------------------------------------------------------------------------------------
// Receipts (§5)
// ---------------------------------------------------------------------------------------------

export interface FilePart {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const uploadReceiptRaw = (s: Session, file: FilePart) => apiCall(s, 'POST', epath(s, '/receipts'), { multipart: { file } });

export async function uploadReceipt(s: Session, file: FilePart): Promise<Json> {
  const r = await uploadReceiptRaw(s, file);
  expect(r.status, `upload ${file.name}: ${r.text.slice(0, 300)}`).toBe(201);
  return r.json.data as Json;
}

export const receiptLinkRaw = (s: Session, expenseId: string) => apiCall(s, 'GET', epath(s, `/${expenseId}/receipt`));

/** Polls the receipt link until the image receipt is processed (409 `receipt_processing` meanwhile). */
export async function receiptLink(s: Session, expenseId: string, timeout = 60_000): Promise<{ link: Json; sawProcessing: boolean }> {
  let last: ApiResult | null = null;
  let sawProcessing = false;
  await expect
    .poll(
      async () => {
        last = await receiptLinkRaw(s, expenseId);
        if (last.status === 409) {
          expect(last.json.error?.code).toBe('receipt_processing');
          sawProcessing = true;
        }
        return last.status;
      },
      { timeout, intervals: [300, 1_000, 2_000], message: `receipt link of ${expenseId} (worker on the media queue?)` },
    )
    .toBe(200);
  return { link: last!.json.data as Json, sawProcessing };
}

/** Anonymous GET of a (signed) URL; never follows redirects. */
export async function fetchRaw(url: string): Promise<{ status: number; body: Buffer; headers: Headers; text: string }> {
  const res = await fetch(url, { redirect: 'manual', headers: { Accept: '*/*' } });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers, text: body.toString('utf8').slice(0, 2000) };
}

/** A JPEG (rendered by the browser's canvas) of `w`×`h` px. */
export async function canvasJpeg(browser: Browser, w = 640, h = 480): Promise<Buffer> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const b64 = await page.evaluate(
      ([cw, ch]) => {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const g = c.getContext('2d')!;
        g.fillStyle = '#e8f0e8';
        g.fillRect(0, 0, cw, ch);
        g.fillStyle = '#1b5e20';
        g.font = '32px sans-serif';
        g.fillText('QA receipt ৳ 1,500', 20, 60);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      },
      [w, h] as const,
    );
    return Buffer.from(b64, 'base64');
  } finally {
    await ctx.close();
  }
}

/**
 * Inserts an EXIF APP1 segment right after SOI with Make "QA-Phone" and a GPS IFD (lat 23°48'N, lon 90°24'E = Dhaka),
 * as a phone camera would. Little-endian TIFF; IFD0 {Make, GPSInfo}, GPS IFD {LatRef, Lat, LonRef, Lon}.
 */
export function withGpsExif(jpeg: Buffer): Buffer {
  expect(jpeg[0] === 0xff && jpeg[1] === 0xd8, 'JPEG SOI').toBe(true);
  const make = Buffer.from('QA-Phone\0', 'latin1');
  const entries = (n: number) => 2 + n * 12 + 4;
  const ifd0At = 8;
  const makeAt = ifd0At + entries(2);
  const gpsAt = makeAt + make.length + (make.length % 2);
  const ratAt = gpsAt + entries(4);
  const tiff = Buffer.alloc(ratAt + 48);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0At, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number | Buffer) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (Buffer.isBuffer(value)) value.copy(tiff, at + 8);
    else tiff.writeUInt32LE(value, at + 8);
  };
  tiff.writeUInt16LE(2, ifd0At);
  entry(ifd0At + 2, 0x010f, 2, make.length, makeAt); // Make (ASCII, offset)
  entry(ifd0At + 14, 0x8825, 4, 1, gpsAt); // GPSInfo IFD pointer
  tiff.writeUInt32LE(0, ifd0At + 26);
  make.copy(tiff, makeAt);
  tiff.writeUInt16LE(4, gpsAt);
  entry(gpsAt + 2, 0x0001, 2, 2, Buffer.from('N\0', 'latin1'));
  entry(gpsAt + 14, 0x0002, 5, 3, ratAt);
  entry(gpsAt + 26, 0x0003, 2, 2, Buffer.from('E\0', 'latin1'));
  entry(gpsAt + 38, 0x0004, 5, 3, ratAt + 24);
  tiff.writeUInt32LE(0, gpsAt + 50);
  [23, 1, 48, 1, 0, 1, 90, 1, 24, 1, 0, 1].forEach((v, i) => tiff.writeUInt32LE(v, ratAt + i * 4));
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)]);
}

/** APP1 "Exif" segments of a JPEG (walks the markers up to SOS). */
export function exifSegments(jpeg: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = jpeg.readUInt16BE(i + 2);
    const seg = jpeg.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1 && seg.subarray(0, 6).toString('latin1') === 'Exif\0\0') out.push(seg);
    i += 2 + len;
  }
  return out;
}

/** A minimal, valid one-page PDF (header `%PDF-`, `%%EOF` at the end). */
export function tinyPdf(text = 'QA receipt'): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ---------------------------------------------------------------------------------------------
// Scheduler + test-only clock moves (tinker; ids validated before interpolation)
// ---------------------------------------------------------------------------------------------

/** Runs `expenses:repeat` (§6.2) in-process; the generation job runs on `default` (worker required). */
export function runRepeat(): string {
  const out = tinker(`Illuminate\\Support\\Facades\\Artisan::call('expenses:repeat'); echo 'ran:'.Illuminate\\Support\\Facades\\Artisan::output();`);
  expect(out, `expenses:repeat: ${out}`).toContain('ran:');
  return out;
}

/** Test-only: the recurrence row of an expense series (not part of any response). */
export function recurrence(id: string): Json | null {
  if (!ULID.test(id)) throw new Error('bad id');
  const out = tinker(`echo 'REC:'.json_encode(DB::table('expense_recurrences')->where('id','${id.toLowerCase()}')->first());`);
  const m = out.match(/REC:(.*)$/m);
  return m && m[1] !== 'null' ? (JSON.parse(m[1]) as Json) : null;
}

/** Test-only "clock moved one month": the series' `next_on` becomes `date` (≤ today), so the generator owes one occurrence. */
export function moveNextOn(recurrenceId: string, date: string): void {
  if (!ULID.test(recurrenceId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad input');
  const out = tinker(`echo 'moved:'.DB::table('expense_recurrences')->where('id','${recurrenceId.toLowerCase()}')->update(['next_on'=>'${date}']);`);
  expect(out).toMatch(/moved:1/);
}

/** Test-only: stored bytes of a receipt object on the private disk (S143 "bytes of the stored object checked"). */
export function storedReceipt(mediaId: string): { disk: string; path: string; status: string; bytesB64: string } | null {
  if (!ULID.test(mediaId)) throw new Error('bad id');
  const out = tinker(
    `$m=DB::table('media')->where('id','${mediaId.toLowerCase()}')->first(); if(!$m){ echo 'RCPT:null'; } else { echo 'RCPT:'.json_encode(['disk'=>$m->disk,'path'=>$m->path,'status'=>$m->status,'bytesB64'=>base64_encode((string) Illuminate\\Support\\Facades\\Storage::disk($m->disk)->get($m->path))]); }`,
  );
  const m = out.match(/RCPT:(.*)$/m);
  return m && m[1] !== 'null' ? JSON.parse(m[1]) : null;
}

// ---------------------------------------------------------------------------------------------
// Profit & loss (§7)
// ---------------------------------------------------------------------------------------------

export async function profit(s: Session, from: string, to: string, as: Session = s): Promise<Json> {
  const r = await retryLocked(() => report(s, 'profit', from, to, as));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json;
}

/** Expected §7.1 expense lines of a range, recomputed from the expenses list (every month of the range). */
export async function expectedExpenseLines(s: Session, from: string, to: string): Promise<{ ads: number; other: number; count: number }> {
  const months = new Set<string>([from.slice(0, 7), to.slice(0, 7)]);
  let ads = 0;
  let other = 0;
  let count = 0;
  for (const m of months) {
    for (const e of await listExpenses(s, m)) {
      if (e.spent_on < from || e.spent_on > to) continue;
      count++;
      if (e.category === 'ads') ads += e.amount as number;
      else other += e.amount as number;
    }
  }
  return { ads, other, count };
}

/** §7.1 identities on a profit summary-like row. */
export function expectProfitIdentity(row: Json, label: string): void {
  expect(row.ad_spend_amount, `${label}: ad_spend_amount is a number (P87-2)`).not.toBeNull();
  const before = row.revenue_amount - (row.product_cost_amount + row.delivery_cost_amount + (row.cod_fee_amount ?? 0));
  if ('profit_before_expenses_amount' in row) expect(row.profit_before_expenses_amount, `${label}: profit before expenses`).toBe(before);
  expect(row.total_cost_amount, `${label}: total cost includes expenses`).toBe(
    row.product_cost_amount + row.delivery_cost_amount + (row.cod_fee_amount ?? 0) + row.ad_spend_amount + row.other_expenses_amount,
  );
  expect(row.net_profit_amount, `${label}: net = revenue − total cost`).toBe(row.revenue_amount - row.total_cost_amount);
}

// ---------------------------------------------------------------------------------------------
// UI (§10)
// ---------------------------------------------------------------------------------------------

export const mUrl = (path = '') => `${urls.merchant}${path}`;

export async function openExpenses(page: Page, query = ''): Promise<void> {
  await page.goto(mUrl(`${EXPENSES}${query}`));
  await expect(page.getByRole('heading', { name: /^Expenses$/, level: 1 })).toBeVisible({ timeout: 20_000 });
}

/** Reports tab bar (7.x `Tabs aria-label="Reports"`). */
export const reportsTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Reports' }).or(page.getByRole('navigation', { name: 'Reports' })).first();
export const reportsTab = (page: Page, name: RegExp): Locator =>
  reportsTabs(page).getByRole('tab', { name }).or(reportsTabs(page).getByRole('link', { name })).or(reportsTabs(page).getByRole('button', { name }));

/** KPI tile by its exact title ("Spent in November", "Ads", "Profit after expenses", "Cost per order"). */
export const tile = (page: Page, title: string): Locator => kpi(page, title);

/** The add/edit card (title "Add expense" or "Edit expense"). */
export function expenseCard(page: Page, title: RegExp = /^(Add|Edit) expense$/): Locator {
  const heading = page.getByRole('heading', { name: title }).first();
  return page
    .getByRole('form', { name: title })
    .or(page.getByRole('region', { name: title }))
    .or(heading.locator('xpath=ancestor::*[self::form or self::section or @role="region" or contains(concat(" ", @class, " "), " rounded-card ")][1]'))
    .first();
}

/** "+ Add expense" (opens / focuses the card; below `lg` it expands it). */
export const addExpenseButton = (page: Page): Locator => page.getByRole('button', { name: /^\+?\s*Add expense$/ }).first();
export const saveExpenseButton = (scope: Page | Locator): Locator => scope.getByRole('button', { name: /^(Save expense|Save changes|Save)$/ }).first();
export const exportCsvButton = (page: Page): Locator => page.getByRole('button', { name: /Export CSV/ }).or(page.getByRole('link', { name: /Export CSV/ })).first();
export const repeatToggle = (scope: Page | Locator): Locator =>
  scope.getByRole('switch', { name: /Repeat every month/ }).or(scope.getByRole('checkbox', { name: /Repeat every month/ })).first();
export const categoryChip = (page: Page, label: string): Locator =>
  page
    .getByRole('radio', { name: label, exact: true })
    .or(page.getByRole('tab', { name: label, exact: true }))
    .or(page.getByRole('button', { name: label, exact: true }))
    .first();
export const expenseRow = (page: Page, text: string | RegExp): Locator =>
  page.getByRole('row').filter({ hasText: text }).or(page.getByRole('listitem').filter({ hasText: text })).or(page.getByRole('button').filter({ hasText: text })).first();

/** Selects an option in a native select or a combobox by its visible label. */
export async function choose(scope: Page | Locator, label: RegExp, option: string): Promise<void> {
  const field = scope.getByLabel(label).first();
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') await field.selectOption({ label: option });
  else {
    await field.click();
    const page = 'page' in scope && typeof scope.page === 'function' ? (scope as Locator).page() : (scope as Page);
    await page.getByRole('option', { name: option, exact: true }).first().click();
  }
}

/** Fills the add/edit card. `amount` is in taka as typed ("1500" / "1500.50"). */
export async function fillExpenseCard(
  page: Page,
  o: { amount?: string; category?: Category; paidFrom?: string; date?: string; note?: string; receipt?: FilePart; repeat?: boolean },
): Promise<Locator> {
  const card = expenseCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  if (o.amount !== undefined) await card.getByLabel(/^Amount/).first().fill(o.amount);
  if (o.category) await choose(card, /^Category/, CATEGORY_LABEL[o.category]);
  if (o.paidFrom) await choose(card, /^Paid from/, o.paidFrom);
  if (o.date) await card.getByLabel(/^Date/).first().fill(o.date);
  if (o.note !== undefined) await card.getByLabel(/^Note/).first().fill(o.note);
  if (o.receipt) {
    await card.locator('input[type="file"]').first().setInputFiles(o.receipt);
    await expect(card.getByText(o.receipt.name).first(), 'receipt chip with the file name').toBeVisible({ timeout: 20_000 });
  }
  if (o.repeat !== undefined) {
    const t = repeatToggle(card);
    const on = (await t.getAttribute('aria-checked')) === 'true' || (await t.isChecked().catch(() => false));
    if (on !== o.repeat) await t.click();
  }
  return card;
}

/** Saves the card and waits for the POST/PATCH answer. */
export async function saveExpenseCard(page: Page, method: 'POST' | 'PATCH' = 'POST'): Promise<Json> {
  const resp = page.waitForResponse((r) => r.request().method() === method && /\/expenses(\/[0-9A-Za-z]{26})?$/.test(new URL(r.url()).pathname));
  await saveExpenseButton(expenseCard(page)).click();
  const r = await resp;
  const body = (await r.json().catch(() => ({}))) as Json;
  expect(r.status(), JSON.stringify(body)).toBe(method === 'POST' ? 201 : 200);
  return body.data as Json;
}
