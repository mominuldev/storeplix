import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { apiCall, LARAVEL_LOG, mailMark, tinker, type ApiResult, type Session } from './api';
import { setPlan, type CommerceShop } from './commerce';
import { adjust, createLocation, defaultLocation, mUrl } from './locations';
import { purchasingShop, retryLocked, spath } from './purchasing';

/**
 * Phase 8.8d part A helpers (PHASE-8-8D-CONTRACT §4–§8, §10, §11.1–§11.5, §11.8, §14 QA): registers, cash sessions, the
 * till sale, receipts and the POS screens. Real API, no mocks.
 *
 * Shapes follow `packages/types` (openapi 1.21.0): `PosRegister`, `PosSession` (+ `totals`), `PosCatalogItem`,
 * `PosQuote`, `PosSale` (+ `receipt: PosReceipt`, `sms_receipt_status`). Open, close and sale need an Idempotency-Key
 * (400 `idempotency_key_required` without it). Phones go in local format and come back as `8801…`.
 *
 * Fixture (`posShop`): a throwaway shop (commerce.ts: "QA Muslin Wrap" ৳ 500 simple, "QA Cotton Kurta" M ৳ 1,200 /
 * L ৳ 1,400) whose default location "Main warehouse" (= online) holds `online` units per variant, plus a `shop` location
 * "Mirpur shop" holding `atShop` units per variant (inventory adjustment) and "Register 1" at Mirpur shop.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const POS = '/pos';
export const MIRPUR = 'Mirpur shop';
export const PLAN_NOTE = /POS is on the Growth plan/;
export const WRAP = 'QA Muslin Wrap';
export const KURTA = 'QA Cotton Kurta';
export const WRAP_PRICE = 50000;
export const KURTA_M_PRICE = 120000;
/** BDT denominations (P88D-15), minor units. */
export const DENOMS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100];
/** `config('pos.variance_tolerance_amount')` default (৳ 50). */
export const TOLERANCE = 5000;

export const idem = () => ({ 'Idempotency-Key': randomUUID() });

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

export async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 500)}`).toBe(status);
  return r.json.data as Json;
}

export const pp = (s: Session, rest: string) => spath(s, `/pos${rest}`);

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

export interface PosShop extends CommerceShop {
  main: Json;
  shop: Json;
  register: Json;
  wrap: string;
  kurtaM: string;
  kurtaL: string;
}

export async function posShop(label: string, plan: 'free' | 'starter' | 'growth' = 'growth', o: { online?: number; atShop?: number } = {}): Promise<PosShop> {
  // Register create needs plan `pos` (Growth): build on Growth, then switch the plan.
  const base = await purchasingShop(label, 'growth', o.online ?? 10);
  try {
    const main = await defaultLocation(base.s);
    const shop = await createLocation(base.s, MIRPUR, { address: 'Section 10, Mirpur, Dhaka' });
    const wrap = base.simple.variantId;
    const kurtaM = base.variable.variants[0].id as string;
    const kurtaL = base.variable.variants[1].id as string;
    const atShop = o.atShop ?? 5;
    if (atShop > 0) await adjust(base.s, [wrap, kurtaM, kurtaL].map((v) => ({ variant_id: v, quantity: atShop, location_id: shop.id })));
    const register = await ok(await createRegisterRaw(base.s, { name: 'Register 1', location_id: shop.id }), 201, 'create register');
    if (plan !== 'growth') setPlan(base.s, plan);
    return { ...base, main, shop, register, wrap, kurtaM, kurtaL };
  } catch (e) {
    base.cleanup();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// API (§10)
// ---------------------------------------------------------------------------------------------

export const registersRaw = (s: Session, as: Session = s) => call(as, 'GET', pp(s, '/registers'));
export async function registers(s: Session): Promise<Json[]> {
  return (await ok(await registersRaw(s), 200, 'list registers')) as unknown as Json[];
}
export const createRegisterRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', pp(s, '/registers'), body);
export const patchRegisterRaw = (s: Session, id: string, body: Json, as: Session = s) => call(as, 'PATCH', pp(s, `/registers/${id}`), body);
export const registerActionRaw = (s: Session, id: string, action: 'archive' | 'unarchive', as: Session = s) => call(as, 'POST', pp(s, `/registers/${id}/${action}`), {});

export const openRaw = (s: Session, registerId: string, body: Json, as: Session = s, headers: Record<string, string> | null = idem()) =>
  call(as, 'POST', pp(s, `/registers/${registerId}/open`), body, headers ?? undefined);
export async function openSession(s: Session, registerId: string, body: Json = { opening_cash_amount: 200000 }): Promise<Json> {
  return ok(await openRaw(s, registerId, body), 201, 'open register');
}

export const sessionRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', pp(s, `/sessions/${id}`));
export async function session(s: Session, id: string): Promise<Json> {
  return ok(await sessionRaw(s, id), 200, `session ${id}`);
}
export const closeRaw = (s: Session, id: string, body: Json, as: Session = s, headers: Record<string, string> | null = idem()) =>
  call(as, 'POST', pp(s, `/sessions/${id}/close`), body, headers ?? undefined);

export const catalogRaw = (s: Session, query: string, as: Session = s) => call(as, 'GET', pp(s, `/catalog?${query}`));
export const lookupRaw = (s: Session, registerId: string, code: string, as: Session = s) =>
  call(as, 'GET', pp(s, `/lookup?register_id=${registerId}&code=${encodeURIComponent(code)}`));
export const customerLookupRaw = (s: Session, phone: string, as: Session = s) => call(as, 'GET', pp(s, `/customers/lookup?phone=${encodeURIComponent(phone)}`));
export const quoteRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', pp(s, '/quote'), body);
export async function quote(s: Session, sessionId: string, lines: Array<{ variant_id: string; quantity: number }>, extra: Json = {}): Promise<Json> {
  return ok(await quoteRaw(s, { session_id: sessionId, lines, ...extra }), 200, 'quote');
}

export const saleRaw = (s: Session, body: Json, as: Session = s, headers: Record<string, string> | null = idem()) =>
  call(as, 'POST', pp(s, '/sales'), body, headers ?? undefined);
export const saleGetRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', pp(s, `/sales/${id}`));
export const smsReceiptRaw = (s: Session, id: string, as: Session = s) => call(as, 'POST', pp(s, `/sales/${id}/sms-receipt`), {});

/** A cash sale at the quoted total (tendered = total unless given). */
export async function cashSale(s: Session, sessionId: string, lines: Array<{ variant_id: string; quantity: number }>, extra: Json = {}): Promise<Json> {
  const q = await quote(s, sessionId, lines);
  const total = q.total_amount as number;
  return ok(
    await saleRaw(s, {
      session_id: sessionId,
      lines,
      expected_total_amount: total,
      payments: [{ method: 'cash', amount: total }],
      tendered_cash_amount: total,
      sms_receipt: false,
      ...extra,
    }),
    201,
    'cash sale',
  );
}

export async function orderByNumber(s: Session, number: string): Promise<Json> {
  const r = await call(s, 'GET', spath(s, `/orders?q=${encodeURIComponent(number)}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  const o = (r.json.data as Json[]).find((x) => x.number === number);
  expect(o, `order ${number} in the list`).toBeTruthy();
  return o!;
}

export async function orderDetail(s: Session, id: string): Promise<Json> {
  return ok(await call(s, 'GET', spath(s, `/orders/${id}`)), 200, `order ${id}`);
}

export async function ordersWhere(s: Session, query: string): Promise<Json[]> {
  const r = await call(s, 'GET', spath(s, `/orders?${query}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json[];
}

/** Rows written by the fake SMS driver for this tenant with purpose `pos_receipt` (local stack only). */
export function posSmsRows(tenantId: string): Array<{ to: string; status: string; template: string }> {
  if (!/^[0-9a-z]{26}$/i.test(tenantId)) throw new Error('bad id');
  const out = tinker(
    `echo json_encode(DB::table('sms_messages')->where('tenant_id','${tenantId}')->where('purpose','pos_receipt')->orderBy('created_at')->get(['to','status','template']));`,
  );
  const m = /\[.*\]/s.exec(out);
  return m ? (JSON.parse(m[0]) as Array<{ to: string; status: string; template: string }>) : [];
}

/** The counts object for an amount, greedy over the BDT list. */
export function countsFor(amount: number): Record<string, number> {
  const out: Record<string, number> = {};
  let rest = amount;
  for (const d of DENOMS) {
    const n = Math.floor(rest / d);
    if (n > 0) {
      out[String(d)] = n;
      rest -= n * d;
    }
  }
  expect(rest, `${amount} is a sum of BDT notes`).toBe(0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// UI (§11)
// ---------------------------------------------------------------------------------------------

/** "৳ 1,234" / "৳1,234.50" → minor units. */
export function bdt(text: string): number {
  const m = /(-|−)?\s*৳\s*([\d,]+(?:\.\d{1,2})?)/.exec(text);
  expect(m, `money in "${text}"`).toBeTruthy();
  const v = Math.round(Number(m![2]!.replace(/,/g, '')) * 100);
  return m![1] ? -v : v;
}

export const tid = (scope: Page | Locator, id: string): Locator => scope.getByTestId(id);

export async function gotoPos(page: Page, path = POS): Promise<void> {
  await page.goto(mUrl(path));
  await expect(page.getByRole('heading', { name: 'Point of sale' })).toBeVisible({ timeout: 25_000 });
}

/** Types a denomination count on the open / close table. */
export async function setCount(page: Page, denomination: number, count: number): Promise<void> {
  const label = `Count of ৳ ${(denomination / 100).toLocaleString('en-US')}`;
  const box = page.getByLabel(label, { exact: true }).or(page.getByRole('textbox', { name: new RegExp(`^Count of ৳\\s?${(denomination / 100).toLocaleString('en-US')}$`) })).first();
  await box.fill(String(count));
}

/** Clears every count box on the table. */
export async function clearCounts(page: Page): Promise<void> {
  const boxes = page.getByTestId('pos-denominations').getByRole('textbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).fill('');
}

/** A product tile on the sale screen (accessible name starts with the product name). */
export const tile = (page: Page, name: string): Locator => page.getByTestId('pos-catalog').getByRole('button', { name: new RegExp(`^${name},`) });

/** The cart: the desktop aside (≥ md) or the bottom sheet. */
export const cart = (page: Page): Locator => page.getByTestId('pos-cart').filter({ visible: true }).first();

/** Waits until Charge is enabled (fresh quote) and returns its total. */
export async function chargeTotal(page: Page): Promise<number> {
  const btn = cart(page).getByTestId('pos-charge');
  await expect(btn).toBeEnabled({ timeout: 15_000 });
  return bdt((await btn.innerText()).trim());
}

export const paymentDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Take payment' });
export const saleComplete = (page: Page): Locator => page.getByTestId('pos-sale-complete');

/** Stubs `window.print` and counts calls (P88D-11: the SPA calls the browser dialog). */
export async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints++;
    };
  });
}
export const printCount = (page: Page) => page.evaluate(() => (window as unknown as { __prints: number }).__prints ?? 0);

/** Waits for the POST /pos/sales response triggered by `act`. */
export async function saleResponse(page: Page, act: () => Promise<void>): Promise<{ status: number; body: Json; key: string | null }> {
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && /\/pos\/sales$/.test(new URL(r.url()).pathname), { timeout: 30_000 });
  await act();
  const r = await res;
  return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json, key: r.request().headers()['idempotency-key'] ?? null };
}

/** Byte offset of laravel.log (see `serverErrorsSince`). */
export const logMark = () => mailMark();

/**
 * Laravel ERROR lines logged since `mark`, minus the known local sqlite "database is locked" flake, lines of the
 * developer's own dev API (it shares laravel.log but runs on database/database.sqlite) and Pest runs (`testing.`).
 */
export function serverErrorsSince(mark: number): string[] {
  let text = '';
  try {
    text = readFileSync(LARAVEL_LOG).subarray(mark).toString('utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => /^\[[^\]]+\] \w+\.ERROR:/.test(l))
    // `testing.ERROR` lines come from a Pest run sharing the log file, not from the E2E API.
    .filter((l) => !/^\[[^\]]+\] testing\.ERROR:/.test(l))
    .filter((l) => !/database is locked/.test(l) && !/apps\/api\/database\/database\.sqlite/.test(l))
    .map((l) => l.slice(0, 300));
}

/** API responses ≥ 400 the page saw, minus GET 500s (TanStack Query retries reads; check `serverErrorsSince`). */
export function unexpectedApiErrors(seen: string[], allow: RegExp[] = []): string[] {
  return seen.filter((e) => !/^GET .* → 500$/.test(e) && !allow.some((a) => a.test(e)));
}
