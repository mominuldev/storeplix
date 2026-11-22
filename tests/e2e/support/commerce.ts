import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { api, createTenant, tinker, unique, urls, type ApiResult, type Session, type ThrowawayTenant } from './api';
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
export const randomIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

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

/** `http://{host}:{port}` with the port of STOREFRONT_URL (default 3000). */
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
