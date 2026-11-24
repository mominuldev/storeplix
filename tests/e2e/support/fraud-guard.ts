import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { api, apiCall, LARAVEL_LOG, mailMark, tinker, urls, type ApiResult, type Session } from './api';
import { digits, sink } from './campaigns';
import {
  cartAdd,
  checkout,
  checkoutBody,
  expectedTotal,
  fakeGatewayOutcome,
  GEO,
  orderIdByNumber,
  randomPhone,
  setPlan,
  setupShop,
  sf,
  transition,
  type CommerceShop,
} from './commerce';

/**
 * Phase 8.8a helpers (PHASE-8-8-CONTRACT §3–§10, §13 QA): fake-order guard API (§8.1), own-shop delivery records built
 * through real manual orders (§3.1), the order `guard` payload (§6.5), storefront checkout rules + OTP (§7), the OTP
 * read from the dev message sink (or the API log), and the guard UI selectors (one helper per label, so a renamed label
 * is fixed in one place).
 *
 * ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA; fixed at the gate otherwise):
 *  - Order payload `guard: {hold, tier, rate, reasons[], decision, record, payment_link_id, checked_at}` (§6.5); a
 *    finished check has `checked_at` set and `hold !== 'checking'`. `decision` ∈ none|hold|advance|skipped.
 *  - The checkout OTP SMS (template `checkout_otp`) is recorded in the dev message sink
 *    (`GET /dev/stores/{store}/message-sink`, CAMPAIGNS_DEV_SINK=true) with `to` = the msisdn and the 6-digit code in
 *    `text`. Fallback: the `sms.log_driver` line of laravel.log (SMS_DRIVER=log), read locally or through tinker.
 *  - `POST /storefront/checkout/otp {phone}` takes the cart token like checkout (sent; harmless if ignored).
 *  - A held pending order answers 409 `order_held` on booking (the hold check runs before the status check), and bulk
 *    confirm skips it with `{id, reason: 'order_held'}`.
 *  - Guard page `/orders/fraud-guard` (§10.1): H1 "Fake order guard"; Tag "Protection on"/"Protection off"; KPI tiles
 *    "Orders protected this month", "Fake orders stopped", "Advance collected"; six rule cards titled as in Figma (VPN
 *    and courier-record rules absent); "Reset to recommended"; buttons "Check a number", "Block a number"; privacy card
 *    "Your data stays yours"; plan note "Fake order guard is on Starter and Growth." + "See plans".
 *  - Order detail (§10.2): status stays "Pending" with a Tag "Call first" / "Waiting for advance" / "Checking…"; the
 *    call_first banner reads "Held for a call — {reason}" with buttons "Release and confirm" / "Cancel as fake";
 *    Delivery record card with a "Your shop" bar only.
 *  - Storefront (§10.4): OTP field labelled "Verification code" (6 boxes or one `autocomplete=one-time-code` input), help
 *    "We sent a 6-digit code to {phone}."; COD-unavailable + daily-limit copy as in §10.4 / P88-11.
 *  - Workers: `CheckOrderRisk` runs on `default` (compose `queue`), so a `queue:work` must consume it locally.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const GUARD = '/orders/fraud-guard';
export const REASONS = ['rate_below_hold', 'rate_below_advance', 'few_parcels', 'new_number', 'duplicate', 'blocked_number', 'no_gateway', 'otp_unavailable'] as const;
export const RULE_TITLES = [
  'Hold risky orders for a call',
  'Ask for delivery charge in advance',
  'Verify new numbers with OTP',
  'Block repeat returners',
  'Catch duplicate orders',
  'Limit orders per phone',
] as const;
/** Figma items that must never render (P88-7, Q190, Q191, Q23). */
export const OMITTED = [/Block VPN/i, /Check courier record/i, /Delivery charges saved/i, /across Storeplix/i, /Risk network/i];
export const COD_UNAVAILABLE = /Cash on delivery isn.t available for this number\. Please pay online\./;
export const LIMIT_REACHED = /You.ve reached today.s order limit for cash on delivery\./;
export const PLAN_NOTE = /Fake order guard is on Starter and Growth\./;
const ULID = /^[0-9a-z]{26}$/i;

// ---------------------------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------------------------

/**
 * Published throwaway shop with the guard ON (defaults, Q184–Q199) on `plan`, stock 50 per variant. Callers do all
 * cache-flushing setup (`browserHost`, `mapStoreHost`, `setPlan`) before placing orders: the dev sink and the fake
 * courier's parcels live in the tenant cache. Always `cleanup()`.
 */
export async function guardShop(label: string, plan: 'free' | 'starter' | 'growth' = 'growth'): Promise<CommerceShop> {
  const shop = await setupShop(label, { stock: 50, guard: true });
  try {
    setPlan(shop.s, plan);
    return shop;
  } catch (e) {
    shop.cleanup();
    throw e;
  }
}

/** `017…` → `88017…` (Phone::bdMsisdn). */
export const msisdn = (phone: string) => `880${digits(phone)}`;

// ---------------------------------------------------------------------------------------------
// Guard API (§8.1)
// ---------------------------------------------------------------------------------------------

export const fpath = (s: Session, rest = '') => `/stores/${s.storeId}/fraud-guard${rest}`;

/** Local sqlite only: a "database is locked" 500 under the workers' writes → retry (nothing committed). */
async function retryLocked(fn: () => Promise<ApiResult>): Promise<ApiResult> {
  let r = await fn();
  for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(r.text); i++) {
    await new Promise((res) => setTimeout(res, 700));
    r = await fn();
  }
  return r;
}

export async function guardSettings(s: Session, as: Session = s): Promise<Json> {
  const r = await retryLocked(() => apiCall(as, 'GET', fpath(s, '/settings')));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json;
}

export const patchGuardRaw = (s: Session, change: Json, as: Session = s) => retryLocked(() => apiCall(as, 'PATCH', fpath(s, '/settings'), { json: change }));

export async function patchGuard(s: Session, change: Json): Promise<Json> {
  const r = await patchGuardRaw(s, change);
  expect(r.status, `PATCH guard ${JSON.stringify(change)} → ${r.text.slice(0, 300)}`).toBe(200);
  return r.json.data as Json;
}

export const blockRaw = (s: Session, phone: string, note: string | null = 'QA: fake orders', as: Session = s) =>
  retryLocked(() => apiCall(as, 'POST', fpath(s, '/blocked-numbers'), { json: { phone, note } }));

export async function blockNumber(s: Session, phone: string, note = 'QA: fake orders'): Promise<Json> {
  const r = await blockRaw(s, phone, note);
  expect(r.status, `block ${phone}: ${r.text.slice(0, 300)}`).toBe(201);
  return r.json.data as Json;
}

export async function unblockNumber(s: Session, entryId: string): Promise<void> {
  const r = await retryLocked(() => apiCall(s, 'DELETE', fpath(s, `/blocked-numbers/${entryId}`)));
  expect(r.status, r.text.slice(0, 300)).toBe(204);
}

export async function blockedNumbers(s: Session, q = ''): Promise<Json[]> {
  const r = await retryLocked(() => apiCall(s, 'GET', `${fpath(s, '/blocked-numbers')}${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json[];
}

export const checkNumberRaw = (s: Session, phone: string, as: Session = s) => retryLocked(() => apiCall(as, 'POST', fpath(s, '/check'), { json: { phone } }));

export async function overview(s: Session, month?: string): Promise<Json> {
  const r = await retryLocked(() => apiCall(s, 'GET', `${fpath(s, '/overview')}${month ? `?month=${month}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json;
}

export async function guardEvents(s: Session, type?: string): Promise<Json[]> {
  const r = await retryLocked(() => apiCall(s, 'GET', `${fpath(s, '/events')}${type ? `?filter[type]=${type}` : ''}`));
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.json.data as Json[];
}

export const releaseRaw = (s: Session, orderId: string, as: Session = s) => retryLocked(() => apiCall(as, 'POST', `/stores/${s.storeId}/orders/${orderId}/guard/release`, { json: {} }));

/** Every §8.1 guard route that needs `fraud.manage` (release excluded: `orders.process`). */
export function managedRoutes(s: Session, entryId: string): Array<[string, string, Json | undefined]> {
  return [
    ['GET', fpath(s, '/settings'), undefined],
    ['PATCH', fpath(s, '/settings'), { daily_limit: 4 }],
    ['POST', fpath(s, '/settings/reset'), {}],
    ['GET', fpath(s, '/overview'), undefined],
    ['GET', fpath(s, '/events'), undefined],
    ['GET', fpath(s, '/blocked-numbers'), undefined],
    ['POST', fpath(s, '/blocked-numbers'), { phone: randomPhone(), note: 'QA denied' }],
    ['DELETE', fpath(s, `/blocked-numbers/${entryId}`), undefined],
    ['POST', fpath(s, '/check'), { phone: randomPhone() }],
  ];
}

// ---------------------------------------------------------------------------------------------
// Own-shop record (§3.1): real manual orders taken to delivered / returned
// ---------------------------------------------------------------------------------------------

async function step(s: Session, id: string, action: 'confirm' | 'ready' | 'ship' | 'deliver' | 'return', body: Json = {}): Promise<void> {
  let r = await transition(s, id, action, body);
  for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(JSON.stringify(r.json)); i++) {
    await new Promise((res) => setTimeout(res, 700));
    r = await transition(s, id, action, body);
  }
  expect(r.status, `${action}: ${JSON.stringify(r.json)}`).toBe(200);
}

/** Dashboard (manual) order: checked without actions (P88-6), never held. Returns the order id. */
export async function manualOrder(shop: CommerceShop, phone: string, variantId = shop.simple.variantId): Promise<string> {
  const body = {
    items: [{ variant_id: variantId, quantity: 1 }],
    channel: 'phone',
    contact: { name: 'Karim Mia', phone },
    shipping_address: { ...GEO.dhanmondi, address_line: 'House 3, Road 9' },
    notify_customer: false,
  };
  const r = await retryLocked(() => apiCall(shop.s, 'POST', `/stores/${shop.s.storeId}/orders`, { json: body, headers: { 'Idempotency-Key': randomUUID() } }));
  expect(r.status, `manual order: ${r.text.slice(0, 300)}`).toBe(201);
  return r.json.data.id as string;
}

/** A finished parcel for `phone`: manual order → confirm → ready → ship → deliver | return. */
export async function parcel(shop: CommerceShop, phone: string, outcome: 'delivered' | 'returned'): Promise<string> {
  const id = await manualOrder(shop, phone);
  await step(shop.s, id, 'confirm');
  await step(shop.s, id, 'ready');
  await step(shop.s, id, 'ship', { carrier_name: 'Steadfast', tracking_code: `QA-${id.slice(-8)}` });
  await step(shop.s, id, outcome === 'delivered' ? 'deliver' : 'return', outcome === 'returned' ? { restock: [] } : {});
  return id;
}

/** Builds the own-shop record `delivered` / `returned` for `phone` (§3.1). */
export async function buildRecord(shop: CommerceShop, phone: string, delivered: number, returned: number): Promise<void> {
  for (let i = 0; i < delivered; i++) await parcel(shop, phone, 'delivered');
  for (let i = 0; i < returned; i++) await parcel(shop, phone, 'returned');
}

// ---------------------------------------------------------------------------------------------
// Orders: guard payload (§6.5)
// ---------------------------------------------------------------------------------------------

/** Polls the order until its check finished (`guard.checked_at` set, hold not `checking`). Worker on `default` needed. */
export async function waitGuard(s: Session, orderId: string, timeout = 45_000): Promise<Json> {
  let last: Json = {};
  await expect
    .poll(
      async () => {
        const r = await api(s, 'GET', `/stores/${s.storeId}/orders/${orderId}`);
        if (r.status !== 200) return 'retry';
        last = r.json.data as Json;
        const g = last.guard as Json | null;
        return g && g.checked_at && g.hold !== 'checking' ? 'done' : `hold=${g?.hold ?? '-'} checked_at=${g?.checked_at ?? '-'}`;
      },
      { timeout, intervals: [500, 1_000, 2_000], message: `guard check of ${orderId} (CheckOrderRisk worker on default?)` },
    )
    .toBe('done');
  return last;
}

/** Storefront COD order that must be accepted; returns the merchant order id + number. */
export async function placeCod(shop: CommerceShop, phone: string, variantId = shop.simple.variantId, extra: Json = {}): Promise<{ id: string; number: string }> {
  const r = await codCheckout(shop, phone, variantId, extra);
  expect(r.status, `COD checkout ${phone}: ${r.text.slice(0, 400)}`).toBe(201);
  const number = r.json.data.order.number as string;
  return { id: await orderIdByNumber(shop.s, number), number };
}

/** Raw storefront checkout (cart → quote → checkout) for `phone`; `extra` may set `payment_method`, `otp_code`. */
export async function codCheckout(shop: CommerceShop, phone: string, variantId = shop.simple.variantId, extra: Json = {}): Promise<ApiResult & { cart: string }> {
  const { r, cart } = await cartAdd(shop.apiHost, variantId, 1);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const body = checkoutBody(0, { contact: { name: 'Shopper QA', phone, email: null }, ...extra });
  const expected = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  const res = await checkout(shop.apiHost, cart, { ...body, expected_total_amount: expected });
  return { ...res, cart };
}

/** Same cart, another attempt (e.g. after `otp_required`, now with the code). */
export async function checkoutAgain(shop: CommerceShop, cart: string, phone: string, extra: Json = {}): Promise<ApiResult> {
  const body = checkoutBody(0, { contact: { name: 'Shopper QA', phone, email: null }, ...extra });
  const expected = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  return checkout(shop.apiHost, cart, { ...body, expected_total_amount: expected });
}

export const requestOtp = (shop: CommerceShop, phone: string, cart?: string, ip?: string) => sf(shop.apiHost, 'POST', '/checkout/otp', { json: { phone }, cart, ip });

/** Pays an active payment link on the fake gateway (storefront API, then the fake page's "pay"). */
export async function payLink(shop: CommerceShop, linkUrl: string): Promise<void> {
  const token = new URL(linkUrl).pathname.split('/').pop()!;
  const start = await sf(shop.apiHost, 'POST', `/payment-links/${token}/pay`, { idem: randomUUID() });
  expect(start.status, start.text.slice(0, 300)).toBe(200);
  expect(start.json.data?.status).toBe('redirect');
  await fakeGatewayOutcome(start.json.data.redirect_url as string, 'pay');
}

// ---------------------------------------------------------------------------------------------
// OTP from the dev message sink (or the API log)
// ---------------------------------------------------------------------------------------------

const SIX = /(?<!\d)(\d{6})(?!\d)/;

function codeFromLog(phone: string, mark: number): string | null {
  const to = msisdn(phone);
  if (!/^8801\d{9}$/.test(to)) throw new Error('bad phone');
  let lines: string[] = [];
  if (existsSync(LARAVEL_LOG)) {
    const buf = readFileSync(LARAVEL_LOG);
    lines = buf.subarray(Math.min(mark, buf.length)).toString('utf8').split('\n');
  } else {
    // docker compose (E2E_ARTISAN=docker): read the tail of the API log inside the container
    const out = tinker(
      `$f=storage_path('logs/laravel.log'); if(is_file($f)){ $h=fopen($f,'r'); fseek($h, max(0, filesize($f)-400000)); foreach(explode("\\n", stream_get_contents($h)) as $l){ if(str_contains($l,'sms.log_driver') && str_contains($l,'${to}')) echo 'SMSLINE:'.$l."\\n"; } }`,
    );
    lines = out.split('\n').filter((l) => l.startsWith('SMSLINE:'));
  }
  const hits = lines.filter((l) => l.includes('sms.log_driver') && l.includes(`"to":"${to}"`));
  const text = hits.length ? hits[hits.length - 1].replace(/^.*"text":"/, '') : '';
  return text.match(SIX)?.[1] ?? null;
}

/**
 * The newest checkout OTP sent to `phone` (S160): dev sink first (newest first), then the `sms.log_driver` log line
 * written after `mark` (`mailMark()` before requesting the code). Polls while the SMS job runs.
 */
export async function readOtp(s: Session, phone: string, mark: number, timeout = 30_000): Promise<string> {
  let code: string | null = null;
  await expect
    .poll(
      async () => {
        const probe = await api(s, 'GET', `/dev/stores/${s.storeId}/message-sink`);
        if (probe.status === 200) {
          const m = (await sink(s)).find((x) => digits(x.to) === digits(phone) && SIX.test(x.text));
          code = m?.text.match(SIX)?.[1] ?? null;
        }
        code ??= codeFromLog(phone, mark);
        return code !== null;
      },
      { timeout, intervals: [500, 1_000, 2_000], message: `checkout OTP for ${phone} (sink or sms.log_driver line; worker on the SMS queue?)` },
    )
    .toBe(true);
  return code!;
}

export const logMark = mailMark;

// ---------------------------------------------------------------------------------------------
// UI (§10)
// ---------------------------------------------------------------------------------------------

export const mUrl = (path = '') => `${urls.merchant}${path}`;

export async function openGuard(page: Page): Promise<void> {
  await page.goto(mUrl(GUARD));
  await expect(page.getByRole('heading', { name: /^Fake order guard$/, level: 1 })).toBeVisible({ timeout: 20_000 });
}

/** A rule card by its title. */
export function ruleCard(page: Page, title: string): Locator {
  const heading = page.getByText(title, { exact: true }).first();
  return page
    .getByRole('region', { name: title })
    .or(page.getByRole('group', { name: title }))
    .or(heading.locator('xpath=ancestor::*[.//*[@role="switch"] or .//input[@type="checkbox"]][1]'))
    .first();
}

export const ruleSwitch = (page: Page, title: string): Locator =>
  page.getByRole('switch', { name: title }).or(ruleCard(page, title).getByRole('switch')).or(ruleCard(page, title).getByRole('checkbox')).first();

export const planNote = (page: Page): Locator => page.getByText(PLAN_NOTE).first();
export const protectionTag = (page: Page, on: boolean): Locator => page.getByText(on ? /^Protection on$/ : /^Protection off$/).first();

/** Order detail hold Tag beside the Pending badge (P88-2, composed). */
export const holdTag = (page: Page, label: 'Call first' | 'Waiting for advance' | 'Checking…'): Locator => page.getByText(label, { exact: true }).first();
export const heldBanner = (page: Page): Locator => page.getByText(/Held for a call/).first();
export const releaseAndConfirm = (page: Page): Locator => page.getByRole('button', { name: /^Release and confirm$/ }).first();
export const cancelAsFake = (page: Page): Locator => page.getByRole('button', { name: /^Cancel as fake$/ }).first();
/** Delivery record card (`33:4122`), "Your shop" bar only. */
export const deliveryRecord = (page: Page): Locator =>
  page
    .getByRole('region', { name: /Delivery record/ })
    .or(page.getByText(/^Delivery record$/).first().locator('xpath=ancestor::*[contains(., "Your shop")][1]'))
    .first();

/** Storefront OTP inputs: one `one-time-code` input or six digit boxes inside the "Verification code" group. */
export async function fillOtp(page: Page, code: string): Promise<void> {
  const group = page.getByRole('group', { name: /Verification code/ });
  const single = page.locator('input[autocomplete="one-time-code"]');
  const boxes = (await group.count()) > 0 ? group.locator('input') : single;
  const n = await boxes.count();
  if (n >= 6) {
    for (let i = 0; i < 6; i++) await boxes.nth(i).fill(code[i]);
  } else if (n === 1) {
    await boxes.first().fill(code);
  } else {
    await page.getByLabel(/Verification code/).first().click();
    await page.keyboard.type(code);
  }
}

export const otpHelp = (page: Page): Locator => page.getByText(/We sent a 6-digit code to/).first();

/** True when the id looks like a ULID (guards tinker interpolation in specs). */
export const isUlid = (id: string) => ULID.test(id);
