import { randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { api, apiCall, createTenant, tinker, unique, urls, type ApiResult, type Session, type ThrowawayTenant } from './api';
import { storefrontKey } from './catalog';

/**
 * Phase 5a helpers (PHASE-5-CONTRACT §12 QA). Destructive commerce flows (orders, deliver, refund,
 * publish blockers, plan limits) run on throwaway tenants ("shops") only, never on the demo store.
 * Storefront API calls go server-to-server, exactly like the Next.js storefront: X-Storefront-Key +
 * X-Storefront-Host (+ X-Cart-Token, X-Storefront-Client-Ip).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Geo codes from GET /geo/bd (dataset 2026.11.1).
export const GEO = {
  dhanmondi: { district_code: 'dhaka', thana_code: 'dhaka-dhanmondi' }, // city thana (Inside Dhaka)
  savar: { district_code: 'dhaka', thana_code: 'dhaka-savar' }, // Dhaka district, not a city thana
  gazipur: { district_code: 'gazipur', thana_code: 'gazipur-kaliakair' }, // whole-district zone in setupShop
  chattogram: { district_code: 'chattogram', thana_code: 'chattogram-bandar' }, // fallback
};

export const randomPhone = () => `017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
/**
 * A fresh shopper IP per call (OPEN-QUESTIONS Q66). The old pick of 1 in 250 random addresses collided inside one
 * minute often enough to trip the per-IP checkout limiter (10/min) in unrelated specs. Now: benchmark range
 * 198.18.0.0/15 (131 072 addresses), a random start per process, then sequential, so a run never reuses an address
 * and parallel runs almost never meet.
 */
let ipCursor = Math.floor(Math.random() * 131_072);
export const randomIp = () => {
  const n = ipCursor++ % 131_072;
  return `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
};

export interface SfOptions {
  json?: unknown;
  cart?: string | null;
  idem?: string | null;
  ip?: string;
  preview?: string;
  headers?: Record<string, string>;
  key?: string;
}

/** Storefront API call as the Next.js server makes it. `path` is relative to /api/v1/storefront. */
export async function sf(host: string, method: string, path: string, o: SfOptions = {}): Promise<ApiResult & { ms: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Key': o.key ?? storefrontKey(),
    'X-Storefront-Host': host,
    'X-Storefront-Client-Ip': o.ip ?? randomIp(),
    ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(o.cart ? { 'X-Cart-Token': o.cart } : {}),
    ...(o.idem ? { 'Idempotency-Key': o.idem } : {}),
    ...(o.preview ? { 'X-Storefront-Preview': o.preview } : {}),
    ...(o.headers ?? {}),
  };
  const started = performance.now();
  const res = await fetch(`${urls.api}/api/v1/storefront${path}`, { method, headers, body: o.json === undefined ? undefined : JSON.stringify(o.json) });
  const text = await res.text();
  const ms = performance.now() - started;
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers), ms };
}

/** Adds to a (new) cart; returns the cart token (the one from meta.cart_token on create). */
export async function cartAdd(host: string, variantId: string, quantity = 1, cart?: string | null): Promise<{ r: ApiResult; cart: string }> {
  const r = await sf(host, 'POST', '/cart/items', { json: { variant_id: variantId, quantity }, cart });
  return { r, cart: (r.json.meta?.cart_token as string | undefined) ?? cart ?? '' };
}

export function checkoutBody(expected: number, over: Json = {}): Json {
  const { contact, shipping_address, ...rest } = over;
  return {
    contact: { name: 'Rahim Uddin', phone: randomPhone(), email: null, ...(contact ?? {}) },
    shipping_address: { ...GEO.dhanmondi, area: 'Road 7A area', address_line: 'House 12, Road 7A, Flat 4B', landmark: null, label: 'home', ...(shipping_address ?? {}) },
    payment_method: 'cod',
    customer_note: null,
    expected_total_amount: expected,
    ...rest,
  };
}

export function checkout(host: string, cart: string, body: Json, key: string | null = randomUUID(), ip = randomIp()) {
  return sf(host, 'POST', '/checkout', { json: body, cart, idem: key, ip });
}

/** Cart → shipping quote → checkout with the right expected total. Returns the created order. */
export async function placeOrder(shop: CommerceShop, variantId: string, quantity = 1, over: Json = {}): Promise<{ order: Json; token: string; cart: string }> {
  const { r, cart } = await cartAdd(shop.apiHost, variantId, quantity);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  if (over.coupon) expect((await sf(shop.apiHost, 'PUT', '/cart/coupon', { json: { code: over.coupon }, cart })).status).toBe(200);
  const body = checkoutBody(0, over.body ?? {});
  const expected = await expectedTotal(shop.apiHost, cart, body.shipping_address);
  const res = await checkout(shop.apiHost, cart, { ...body, expected_total_amount: expected });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { order: res.json.data.order, token: res.json.data.confirmation_token, cart };
}

/** Estimated total + the quote for this address (the storefront shows the same sum). */
export async function expectedTotal(host: string, cart: string, address: { district_code: string; thana_code: string }): Promise<number> {
  const c = await sf(host, 'GET', '/cart', { cart });
  const q = await sf(host, 'GET', `/cart/shipping-options?district_code=${address.district_code}&thana_code=${address.thana_code}`, { cart });
  expect(q.status, JSON.stringify(q.json)).toBe(200);
  const shippingFree = c.json.data.coupon?.free_shipping === true;
  return c.json.data.estimated_total_amount + (shippingFree ? 0 : q.json.data.amount);
}

// ---------------------------------------------------------------------------------------------
// Throwaway shop: tenant + store + category + products + zones + contact phone (+ publish)
// ---------------------------------------------------------------------------------------------
export interface CommerceShop {
  t: ThrowawayTenant;
  s: Session;
  /** `{slug}.storeplix.test`, the platform host created with the store (API calls) */
  apiHost: string;
  /** `{slug}.localhost`, added for the browser (only after `browserHost()`) */
  localHost: string;
  storefront: string;
  category: { id: string; slug: string };
  /** variable product: sizes M/L, one colour, stock 3 each, cost set */
  variable: { id: string; slug: string; variants: Json[] };
  /** simple product: stock 5, low threshold 5 (so "Only N left" shows), cost set */
  simple: { id: string; slug: string; variantId: string };
  cleanup: () => void;
}

export interface ShopOptions {
  publish?: boolean;
  stock?: number;
  freeOver?: number | null;
  /**
   * Phase 8.8a fake-order guard (PHASE-8-8 §4, §6.6). New shops trial Starter, which has `fake_order_guard`, and the
   * guard is on by default (OTP for new numbers, daily limit 3, duplicates, holds). Every spec written before 8.8a
   * expects the 8.7 checkout, so the guard is switched OFF here unless `guard: true` (phase8-8.* only). "Guard off"
   * = order flow identical to 8.7 (§6.6), apart from the tier change.
   */
  guard?: boolean;
}

/** PATCH the store's guard settings (§6.1). Tolerates a pre-8.8a API without the route (404 that isn't store_not_found). */
export async function setGuardEnabled(s: Session, enabled: boolean): Promise<void> {
  const r = await api(s, 'PATCH', `/stores/${s.storeId}/fraud-guard/settings`, { enabled });
  if (r.status === 404 && r.json.error?.code !== 'store_not_found') return;
  expect(r.status, `fraud-guard settings enabled=${enabled}: ${JSON.stringify(r.json)}`).toBe(200);
}

export async function setupShop(label: string, o: ShopOptions = {}): Promise<CommerceShop> {
  const t = await createTenant(label);
  const s = t.session;
  const sid = s.storeId;
  const store = await api(s, 'GET', `/stores/${sid}`);
  const slug = (store.json.data?.slug as string) ?? t.slug;
  try {
    const set = await api(s, 'PATCH', `/stores/${sid}/settings`, { contact: { phone: '01700000001', email: `${t.email}` } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const cat = await api(s, 'POST', `/stores/${sid}/categories`, { name: `QA Kurtas ${unique('')}` });
    expect(cat.status, JSON.stringify(cat.json)).toBe(201);
    const variable = await api(s, 'POST', `/stores/${sid}/products`, {
      name: 'QA Cotton Kurta',
      status: 'active',
      category_ids: [cat.json.data.id],
      options: [{ name: 'Size', values: ['M', 'L'] }],
      variants: [
        { option_values: ['M'], sku: unique('QA-M-').toUpperCase(), price_amount: 120000, compare_at_amount: 150000, cost_amount: 70000, initial_on_hand: o.stock ?? 3 },
        { option_values: ['L'], sku: unique('QA-L-').toUpperCase(), price_amount: 140000, compare_at_amount: null, cost_amount: 80000, initial_on_hand: o.stock ?? 3 },
      ],
    });
    expect(variable.status, JSON.stringify(variable.json)).toBe(201);
    const simple = await api(s, 'POST', `/stores/${sid}/products`, {
      name: 'QA Muslin Wrap',
      status: 'active',
      category_ids: [cat.json.data.id],
      variants: [{ sku: unique('QA-W-').toUpperCase(), price_amount: 50000, cost_amount: 20000, initial_on_hand: o.stock ?? 5, low_stock_threshold: 5 }],
    });
    expect(simple.status, JSON.stringify(simple.json)).toBe(201);
    const ship = await api(s, 'PUT', `/stores/${sid}/shipping`, {
      free_delivery_over_amount: o.freeOver === undefined ? 500000 : o.freeOver,
      zones: [
        { name: 'Inside Dhaka', kind: 'custom', charge_amount: 6000, min_days: 1, max_days: 2, areas: [{ district_code: 'dhaka', thana_code: 'dhaka-dhanmondi' }, { district_code: 'gazipur' }] },
        { name: 'Dhaka outskirts', kind: 'custom', charge_amount: 9000, min_days: 1, max_days: 3, areas: [{ district_code: 'dhaka' }] },
        { name: 'Outside Dhaka', kind: 'fallback', charge_amount: 12000, min_days: 2, max_days: 4 },
      ],
    });
    expect(ship.status, JSON.stringify(ship.json)).toBe(200);
    if (o.guard !== true) await setGuardEnabled(s, false);
    if (o.publish !== false) {
      const pub = await api(s, 'POST', `/stores/${sid}/publish`, {});
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    }
    return {
      t,
      s,
      apiHost: `${slug}.storeplix.test`,
      localHost: `${slug}.localhost`,
      storefront: storefrontOrigin(`${slug}.localhost`),
      category: { id: cat.json.data.id, slug: cat.json.data.slug },
      variable: { id: variable.json.data.id, slug: variable.json.data.slug, variants: variable.json.data.variants },
      simple: { id: simple.json.data.id, slug: simple.json.data.slug, variantId: simple.json.data.variants[0].id },
      cleanup: () => t.cleanup(),
    };
  } catch (e) {
    t.cleanup();
    throw e;
  }
}

/** `http://{host}:{port}` with the port of STOREFRONT_URL (default 3010). */
export function storefrontOrigin(host: string): string {
  const u = new URL(urls.storefront);
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
}

/**
 * Adds `{slug}.localhost` as a platform domain so Chromium can open the throwaway shop
 * (test-only DB write; the status is NOT changed, so publish stays a real check).
 */
export function browserHost(shop: CommerceShop): void {
  if (!/^[a-z0-9-]+\.localhost$/.test(shop.localHost) || !/^[0-9a-z]{26}$/i.test(shop.s.storeId)) throw new Error('bad host');
  tinker(
    [
      `$sid='${shop.s.storeId}'; $h='${shop.localHost}'; $s=DB::table('stores')->where('id',$sid)->first();`,
      `if(!DB::table('store_domains')->where('hostname',$h)->exists()){ DB::table('store_domains')->insert(['id'=>(string) Illuminate\\Support\\Str::ulid(),'tenant_id'=>$s->tenant_id,'store_id'=>$sid,'hostname'=>$h,'type'=>'platform','status'=>'active','is_primary'=>false,'created_at'=>now(),'updated_at'=>now()]); }`,
      `Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
    ].join(' '),
  );
}

/** Order transitions through the merchant API. */
export async function transition(s: Session, orderId: string, action: 'confirm' | 'ready' | 'ship' | 'deliver' | 'return' | 'cancel', body: Json = {}) {
  return api(s, 'POST', `/stores/${s.storeId}/orders/${orderId}/${action}`, body);
}

/** `{ on_hand, committed, available, … }` of one variant (from the product resource). */
export async function inventoryOf(s: Session, productId: string, variantId: string): Promise<Json> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/products/${productId}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const v = (r.json.data.variants as Json[]).find((x) => x.id === variantId);
  expect(v, `variant ${variantId}`).toBeTruthy();
  return v!.inventory as Json;
}

/** Ledger rows (inventory movements) of this store for a reason, e.g. `order_shipped`. */
export async function movements(s: Session, reason: string): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/inventory/movements?filter[reason]=${reason}&per_page=100`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** Keys that must never appear anywhere in a storefront payload (S7). */
export const FORBIDDEN_STOREFRONT_KEYS = ['cost_amount', 'unit_cost_amount', 'sku', 'barcode', 'on_hand', 'committed', 'tenant_id', 'store_id', 'revision', 'created_by'];

export function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Json).flatMap(([k, v]) => [...(FORBIDDEN_STOREFRONT_KEYS.includes(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Phase 5b-2 payments (PHASE-5B-CONTRACT §1.B, §4.1–4.5, §11, P5B-29 fake gateway).
// Every route or selector that was written before the product code existed is isolated in ONE helper
// below (marked "GUESS"), so a mismatch is a one-line fix.
// ---------------------------------------------------------------------------------------------
export type Gateway = 'bkash' | 'sslcommerz';
export type FakeOutcome = 'pay' | 'fail' | 'cancel';

/** Throwaway credentials for the fake driver. The secret halves must never come back in any response or log (S26). */
export function fakeCredentials(provider: Gateway, marker = unique('')): Json {
  return provider === 'bkash'
    ? { app_key: `qa-app-key-${marker}-3f9a`, app_secret: `QA-SECRET-${marker}-never-leak`, username: `qa-user-${marker}`, password: `QA-PASS-${marker}-never-leak` }
    : { store_id: `qastore${marker}`, store_passwd: `QA-SSLPASS-${marker}-never-leak` };
}
export const SECRET_FIELDS = ['app_secret', 'password', 'store_passwd'];

/** PUT credentials (sandbox, fake driver) → `connected`; then PATCH `enabled` (and `is_default`) with the revision. */
export async function connectFakeGateway(s: Session, provider: Gateway = 'bkash', o: { enable?: boolean; isDefault?: boolean; credentials?: Json } = {}): Promise<{ account: Json; credentials: Json }> {
  const credentials = o.credentials ?? fakeCredentials(provider);
  const put = await api(s, 'PUT', `/stores/${s.storeId}/payment-gateways/${provider}`, { mode: 'sandbox', credentials });
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  expect(put.json.data.status).toBe('connected');
  let account = put.json.data as Json;
  if (o.enable !== false) {
    const patch = await api(s, 'PATCH', `/stores/${s.storeId}/payment-gateways/${provider}`, { revision: account.revision, enabled: true, ...(o.isDefault ? { is_default: true } : {}) });
    expect(patch.status, JSON.stringify(patch.json)).toBe(200);
    expect(patch.json.data.enabled).toBe(true);
    account = patch.json.data;
  }
  return { account, credentials };
}

/** Store setting `checkout.cod_advance` (P5B-13). */
export async function setCodAdvance(s: Session, mode: 'none' | 'delivery_charge') {
  const r = await api(s, 'PATCH', `/stores/${s.storeId}/settings`, { checkout: { cod_advance: mode } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

/** Storefront checkout with an online method (or COD + advance). Returns order, X-Order-Token, cart and `payment`. */
export async function placeOnlineOrder(
  shop: CommerceShop,
  variantId: string,
  quantity = 1,
  body: Json = {},
): Promise<{ order: Json; token: string; cart: string; payment: Json | null; status: number; json: Json }> {
  const { r, cart } = await cartAdd(shop.apiHost, variantId, quantity);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const b = checkoutBody(0, { payment_method: 'bkash', ...body });
  const expected = await expectedTotal(shop.apiHost, cart, b.shipping_address);
  const res = await checkout(shop.apiHost, cart, { ...b, expected_total_amount: expected });
  return { order: res.json.data?.order, token: res.json.data?.confirmation_token, cart, payment: res.json.data?.payment ?? null, status: res.status, json: res.json };
}

/** Merchant order id by its number. */
export async function orderIdByNumber(s: Session, number: string): Promise<string> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/orders?q=${encodeURIComponent(number)}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const hit = (r.json.data as Json[]).find((o) => o.number === number);
  expect(hit, `order ${number}`).toBeTruthy();
  return hit!.id as string;
}

export async function merchantOrder(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/orders/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

/** Storefront view of the order (thank-you data) with `payment` state (P5B-17). */
export async function confirmation(shop: CommerceShop, token: string): Promise<Json> {
  const r = await sf(shop.apiHost, 'GET', '/orders/confirmation', { headers: { 'X-Order-Token': token } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

/** `POST /storefront/orders/pay` (retry online or switch to COD). */
export function payOrder(shop: CommerceShop, token: string, method: 'cod' | Gateway, key: string = randomUUID()) {
  return sf(shop.apiHost, 'POST', '/orders/pay', { json: { payment_method: method }, idem: key, headers: { 'X-Order-Token': token } });
}

/** Raw fetch without following redirects (API return/fake-gateway URLs are absolute). */
export async function rawFetch(url: string, init: RequestInit = {}): Promise<ApiResult> {
  const res = await fetch(url, { redirect: 'manual', ...init });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
}

const apiOrigin = () => new URL(urls.api).origin;
const isApiUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.origin === apiOrigin() || x.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
};
/** The fake page is served at `{APP_URL}/api/v1/dev/...`; point it at the API under test (APP_URL may differ). */
const onApi = (u: string) => {
  const x = new URL(u, urls.api);
  return `${apiOrigin()}${x.pathname}${x.search}`;
};

/**
 * Server-side "click" on the fake hosted page (P5B-29). GUESS: the page has one <form method=post> per
 * outcome whose action ends in /pay, /fail or /cancel (contract: `POST …/{outcome}`); falls back to that path.
 * Returns every hop (the outcome POST, the signed API return) and the first URL outside the API: the store's
 * `/checkout/payment-result?payment=` (or `/pay/result?payment=` for links).
 */
export async function fakeGatewayOutcome(redirectUrl: string, outcome: FakeOutcome): Promise<{ page: ApiResult; hops: { url: string; status: number }[]; returnUrl: string | null; finalUrl: string }> {
  const pageUrl = onApi(redirectUrl);
  const page = await rawFetch(pageUrl, { headers: { Accept: 'text/html' } });
  expect(page.status, `fake page ${pageUrl}: ${page.text.slice(0, 300)}`).toBe(200);
  const forms = [...page.text.matchAll(/<form[^>]*action="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const action = forms.find((a) => new RegExp(`/${outcome}(\\?|$)`).test(a)) ?? `${pageUrl.split('?')[0]}/${outcome}`;
  const fields = Object.fromEntries([...page.text.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)].map((m) => [m[1], m[2]]));
  const hops: { url: string; status: number }[] = [];
  let url = onApi(action);
  let res = await rawFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: new URLSearchParams(fields).toString() });
  hops.push({ url, status: res.status });
  let returnUrl: string | null = null;
  for (let i = 0; i < 5 && res.status >= 300 && res.status < 400 && res.headers.location; i++) {
    const next = new URL(res.headers.location, url).toString();
    if (!isApiUrl(next)) return { page, hops, returnUrl, finalUrl: next };
    if (/\/payments\/return\//.test(next)) returnUrl = onApi(next);
    url = onApi(next);
    res = await rawFetch(url, { headers: { Accept: 'text/html' } });
    hops.push({ url, status: res.status });
  }
  throw new Error(`fake gateway ${outcome}: no redirect to the store, hops ${JSON.stringify(hops)} body ${res.text.slice(0, 300)}`);
}

/** Only the outcome POST: returns the signed return URL WITHOUT calling it (for forgery/replay checks). */
export async function fakeGatewayReturnUrl(redirectUrl: string, outcome: FakeOutcome): Promise<string> {
  const pageUrl = onApi(redirectUrl);
  const page = await rawFetch(pageUrl, { headers: { Accept: 'text/html' } });
  expect(page.status).toBe(200);
  const forms = [...page.text.matchAll(/<form[^>]*action="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const action = forms.find((a) => new RegExp(`/${outcome}(\\?|$)`).test(a)) ?? `${pageUrl.split('?')[0]}/${outcome}`;
  const fields = Object.fromEntries([...page.text.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)].map((m) => [m[1], m[2]]));
  const res = await rawFetch(onApi(action), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  expect(res.status, res.text.slice(0, 300)).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return onApi(new URL(res.headers.location, onApi(action)).toString());
}

/** Checkout with an online method and complete it on the fake page (API only). */
export async function placeAndPay(shop: CommerceShop, variantId: string, quantity = 1, body: Json = {}, outcome: FakeOutcome = 'pay') {
  const placed = await placeOnlineOrder(shop, variantId, quantity, body);
  expect(placed.status, JSON.stringify(placed.json)).toBe(201);
  expect(placed.payment?.status, JSON.stringify(placed.payment)).toBe('redirect');
  const result = await fakeGatewayOutcome(placed.payment!.redirect_url, outcome);
  return { ...placed, result, orderId: await orderIdByNumber(shop.s, placed.order.number) };
}

/**
 * Hold / link expiry without waiting (P5B-21, P5B-22). Uses API-2's testing-only time travel
 * `POST /dev/payments/{payment}/expire-now` (404 unless PAYMENTS_FAKE=true): it moves the order hold (or the link
 * expiry for a link charge) into the past and runs the same expiry as the scheduled commands. A link nobody tried to
 * pay has no payment row yet, so that case uses a test-only DB write + `payment-links:expire`.
 */
export async function expireHolds(opts: { paymentId?: string; linkId?: string }): Promise<Json | null> {
  if (opts.paymentId) {
    const r = await rawFetch(`${urls.api}/api/v1/dev/payments/${opts.paymentId}/expire-now`, { method: 'POST', headers: { Accept: 'application/json' } });
    expect(r.status, r.text).toBe(200);
    return r.json.data;
  }
  if (!opts.linkId || !/^[0-9a-z]{26}$/i.test(opts.linkId)) throw new Error('bad id');
  tinker(
    `DB::table('payment_links')->where('id','${opts.linkId.toLowerCase()}')->update(['expires_at'=>now()->subMinutes(5)]); Illuminate\\Support\\Facades\\Artisan::call('payment-links:expire'); echo Illuminate\\Support\\Facades\\Artisan::output();`,
  );
  return null;
}

/** Payment links of an order (merchant). */
export async function paymentLinks(s: Session, orderId: string): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/orders/${orderId}/payment-links`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

export async function createPaymentLink(s: Session, orderId: string, body: Json, key: string = randomUUID()): Promise<ApiResult> {
  return apiCall(s, 'POST', `/stores/${s.storeId}/orders/${orderId}/payment-links`, {
    json: { amount_kind: 'delivery_charge', provider: 'bkash', expires_in_minutes: 120, cancel_if_unpaid: true, send_sms: false, ...body },
    headers: { 'Idempotency-Key': key },
  });
}

/** The 12-char token from a link URL `https://{host}/pay/{token}`. */
export const linkToken = (url: string) => new URL(url).pathname.split('/').pop()!;

/** Recursively finds any of `needles` anywhere in a JSON/text payload (S26). */
export function leaks(payload: unknown, needles: string[]): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return needles.filter((n) => n && text.includes(n));
}

// ----- Browser helpers (storefront + fake page). Every selector guess lives here. -----

/**
 * The API redirects gateway returns and builds link URLs from the store's PRIMARY host (local env:
 * `http://{primary}:3010`). Playwright doesn't route requests that are the target of a redirect, and the
 * shopper's `sp_order` cookie lives on `{slug}.localhost`, so browser payment specs make `{slug}.localhost` the
 * primary domain (test-only DB write; `browserHost()` must have added it). API calls keep using `apiHost`.
 */
export function mapStoreHost(shop: CommerceShop): void {
  if (!/^[a-z0-9-]+\.localhost$/.test(shop.localHost) || !/^[0-9a-z]{26}$/i.test(shop.s.storeId)) throw new Error('bad host');
  tinker(
    [
      `$sid='${shop.s.storeId.toLowerCase()}'; $h='${shop.localHost}';`,
      `DB::transaction(function() use ($sid,$h){ DB::table('store_domains')->where('store_id',$sid)->update(['is_primary'=>false]); DB::table('store_domains')->where('store_id',$sid)->where('hostname',$h)->update(['is_primary'=>true]); });`,
      `Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
    ].join(' '),
  );
}

/** Checkout payment option (§11): radios in the "Payment method" group, value = the method (visually hidden input in a card). */
export function paymentOption(page: Page, method: 'cod' | Gateway): Locator {
  return page.getByRole('radiogroup', { name: 'Payment method' }).locator(`input[type="radio"][value="${method}"]`);
}

/** The checkout submit: "Place order — ৳ N" (COD) or "Pay ৳ N with bKash" (online / advance). */
export const placeOrderButton = (page: Page): Locator => page.getByRole('button', { name: /^(Place order|Pay ৳)/ });

/** Selects a payment option by clicking its card (the input itself is sr-only). */
export async function choosePayment(page: Page, method: 'cod' | Gateway): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Payment method' }).locator('label').filter({ has: page.locator(`input[type="radio"][value="${method}"]`) }).click();
  await expect(paymentOption(page, method)).toBeChecked();
}

/** Fills the checkout form exactly as `phase5.storefront-buy` does (Dhanmondi → Inside Dhaka ৳ 60). */
export async function fillCheckout(page: Page, name = 'Rahim Uddin', phone = randomPhone()): Promise<string> {
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Division').selectOption('dhaka');
  await page.getByLabel('District').selectOption('dhaka');
  await page.getByLabel('Upazila / Thana').selectOption('dhaka-dhanmondi');
  await page.getByLabel('House, road, flat').fill('House 12, Road 7A, Flat 4B');
  await expect(page.getByText('Inside Dhaka').first()).toBeVisible();
  return phone;
}

/** Puts an API-created cart into the browser (the storefront reads `sp_cart`), so specs skip the PDP clicks. */
export async function useCart(context: BrowserContext, shop: CommerceShop, cart: string): Promise<void> {
  await context.addCookies([{ name: 'sp_cart', value: cart, domain: shop.localHost, path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

/** GUESS: the fake hosted page has buttons "Pay", "Fail", "Cancel" (P5B-29). */
export async function clickFakeGateway(page: Page, outcome: FakeOutcome): Promise<void> {
  await expect(page).toHaveURL(/\/dev\/fake-gateway\//, { timeout: 20_000 });
  const label = { pay: /^Pay\b/i, fail: /^Fail/i, cancel: /^Cancel/i }[outcome];
  await page.getByRole('button', { name: label }).first().click();
}

/** The store page after the return: `/checkout/payment-result?payment=…` or `/pay/result?payment=…`. */
export async function expectPaymentResultPage(page: Page, link = false): Promise<void> {
  await expect(page).toHaveURL(link ? /\/pay\/result\?payment=/ : /\/checkout\/(payment-result\?payment=|thank-you)/, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------------------------
// Phase 5b-3 couriers (PHASE-5B-CONTRACT §1.C, §4.3, §4.6, §4.7, §6, P5B-29-style fake courier).
// Fake driver only (COURIERS_FAKE=true): no real courier is ever called. Every route or selector guessed before the
// product code existed lives in ONE helper below (marked "GUESS").
// ---------------------------------------------------------------------------------------------
export type Courier = 'steadfast' | 'pathao' | 'redx';

/** Throwaway credentials for the fake courier. The secret halves must never come back in a response (S26). */
export function fakeCourierCredentials(provider: Courier, marker = unique('')): Json {
  if (provider === 'steadfast') return { api_key: `qa-sf-key-${marker}`, secret_key: `QA-SF-SECRET-${marker}-never-leak` };
  if (provider === 'pathao') return { client_id: `qa-pt-${marker}`, client_secret: `QA-PT-SECRET-${marker}-never-leak`, username: `qa-${marker}@e2e.storeplix.test`, password: `QA-PT-PASS-${marker}` };
  return { access_token: `QA-RX-TOKEN-${marker}-never-leak` };
}

/** The store's default pickup location (5a), created when missing. */
export async function ensurePickup(s: Session): Promise<string> {
  const cur = await api(s, 'GET', `/stores/${s.storeId}/shipping`);
  expect(cur.status, JSON.stringify(cur.json)).toBe(200);
  const existing = (cur.json.data.pickup_locations as Json[] | undefined)?.[0];
  if (existing) return existing.id as string;
  const r = await api(s, 'POST', `/stores/${s.storeId}/pickup-locations`, { name: 'Main warehouse', district_code: 'dhaka', thana_code: 'dhaka-dhanmondi', address_line: 'House 12, Road 7A' });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data.id as string;
}

/** Test-only plan switch (subscription row) + FeatureGate cache flush. */
export function setPlan(s: Session, code: 'free' | 'starter' | 'growth'): void {
  if (!/^[0-9a-z]{26}$/i.test(s.tenantId)) throw new Error('bad id');
  tinker(
    [
      `$t='${s.tenantId}';`,
      `DB::table('subscriptions')->where('tenant_id',$t)->update(['plan_id'=>DB::table('plans')->where('code','${code}')->value('id'),'status'=>'active']);`,
      `App\\Domain\\Billing\\FeatureGate::forget($t); Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
    ].join(' '),
  );
}

/** PUT credentials (fake driver; Steadfast has no sandbox, so `live`) with the pickup location → `connected` + the webhook secret (shown once). */
export async function connectFakeCourier(s: Session, provider: Courier = 'steadfast', o: { credentials?: Json; isDefault?: boolean } = {}): Promise<{ account: Json; webhookSecret: string | null; webhookUrl: string | null; credentials: Json }> {
  const pickup = await ensurePickup(s);
  const credentials = o.credentials ?? fakeCourierCredentials(provider);
  const put = await api(s, 'PUT', `/stores/${s.storeId}/couriers/${provider}`, { mode: provider === 'steadfast' ? 'live' : 'sandbox', credentials, settings: { pickup_location_id: pickup } });
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  expect(put.json.data.status).toBe('connected');
  let account = put.json.data as Json;
  if (o.isDefault !== false && !account.is_default) {
    const patch = await api(s, 'PATCH', `/stores/${s.storeId}/couriers/${provider}`, { revision: account.revision, is_default: true });
    expect(patch.status, JSON.stringify(patch.json)).toBe(200);
    account = patch.json.data;
  }
  return { account, webhookSecret: (put.json.meta?.webhook_secret as string | undefined) ?? null, webhookUrl: (account.webhook_url as string | null) ?? null, credentials };
}

/** `POST /orders/{order}/shipments` with an Idempotency-Key. */
export function bookShipment(s: Session, orderId: string, body: Json = {}, key: string = randomUUID()): Promise<ApiResult> {
  return apiCall(s, 'POST', `/stores/${s.storeId}/orders/${orderId}/shipments`, { json: { provider: 'steadfast', ...body }, headers: { 'Idempotency-Key': key } });
}

export async function shipmentDetail(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/shipments/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

export async function shipmentList(s: Session, query = ''): Promise<{ data: Json[]; meta: Json }> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/shipments${query ? `?${query}` : ''}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data, meta: r.json.meta };
}

/** A storefront COD order moved to `confirmed` through the merchant API (bookable). */
export async function confirmedOrder(shop: CommerceShop, variantId = shop.simple.variantId, quantity = 1, over: Json = {}): Promise<{ id: string; number: string; phone: string }> {
  const phone = (over.body?.contact?.phone as string | undefined) ?? randomPhone();
  const placed = await placeOrder(shop, variantId, quantity, { ...over, body: { ...(over.body ?? {}), contact: { ...(over.body?.contact ?? {}), phone } } });
  const id = await orderIdByNumber(shop.s, placed.order.number);
  const c = await transition(shop.s, id, 'confirm');
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  return { id, number: placed.order.number, phone };
}

/**
 * Steadfast-style webhook call (P5B-37, §6.1): JSON `{ consignment_id, invoice, status, cod_amount, updated_at }` with
 * `Authorization: Bearer {secret}`. The URL is the account's `webhook_url`, re-pointed at the API under test.
 */
export async function steadfastWebhook(webhookUrl: string, secret: string | null, payload: Json): Promise<ApiResult> {
  const u = new URL(webhookUrl, urls.api);
  const target = `${new URL(urls.api).origin}${u.pathname}`;
  return rawFetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(secret !== null ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(payload),
  });
}

/**
 * API-C2's testing-only endpoint `POST /dev/shipments/{shipment}/advance` `{status, cod_collected_amount?}` (§15;
 * 404 unless COURIERS_FAKE=true): moves the fake parcel and delivers the change like the courier would (a signed
 * webhook processed inline for Steadfast/Pathao, a poll for RedX). `status` = normalised word or `settled`.
 */
export async function fakeAdvance(shipmentId: string, status: string, extra: Json = {}): Promise<ApiResult> {
  return rawFetch(`${urls.api}/api/v1/dev/shipments/${shipmentId}/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ status, ...extra }),
  });
}

/**
 * Test-only: sets what the fake courier's status API reports for a parcel WITHOUT telling Store Plix (no webhook, no
 * sync), so a webhook or a poll can be checked against the courier's answer (P5B-37 re-query, S32). State lives in the
 * API's tenant cache: never call a helper that flushes the cache (`browserHost`, `setPlan`, `mapStoreHost`) after
 * booking, or the fake forgets its parcels.
 */
export function fakeParcelState(tenantId: string, shipmentId: string, status: string): void {
  if (!/^[0-9a-z]{26}$/i.test(tenantId) || !/^[0-9a-z]{26}$/i.test(shipmentId) || !/^[a-z_]+$/.test(status)) throw new Error('bad input');
  const out = tinker(
    [
      `app(App\\Domain\\Tenancy\\TenantContext::class)->run('${tenantId.toLowerCase()}', function () {`,
      `$s = App\\Domain\\Orders\\Models\\Shipment::query()->whereKey('${shipmentId.toLowerCase()}')->firstOrFail();`,
      `app(App\\Domain\\Couriers\\CourierManager::class)->fake($s->provider)->advance($s, '${status}'); });`,
      `echo 'fake-ok';`,
    ].join(' '),
  );
  expect(out).toContain('fake-ok');
}

/** Wait until the queued webhook/poll processing moved the order (database queue worker). */
export async function waitOrderStatus(s: Session, orderId: string, status: string, timeout = 30_000): Promise<Json> {
  await expect.poll(async () => (await merchantOrder(s, orderId)).status, { timeout, message: `order ${orderId} → ${status}` }).toBe(status);
  return merchantOrder(s, orderId);
}
