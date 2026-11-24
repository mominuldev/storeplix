import { createHmac, timingSafeEqual } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { api, tinker, unique, urls, type ApiResult, type Session } from './api';
import { orderIdByNumber, placeOrder, rawFetch, setPlan, setupShop, type CommerceShop } from './commerce';

/**
 * Phase 8.4 helpers (PHASE-8-4-CONTRACT §3, §4, §6, §7, §10 QA): API keys, the external API, outbound webhooks through
 * the fake driver (`WEBHOOKS_OUT_FAKE=true`) and its dev sink, receiver-side signature verification (P84-8), and the
 * Developer page selectors (one per helper, so a renamed label is fixed in one place).
 *
 * ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA):
 *  - Dev sink `GET /api/v1/dev/webhook-sink` (merchant session, `perm:developers.manage`) answers
 *    `{ data: SinkEntry[] }`, newest first or oldest first (order not relied on); each entry carries the target `url`,
 *    the request `headers` (any case; string or string[] values) and the **raw request body string** exactly as signed
 *    (`body`; `raw_body` also accepted). Without the raw body no receiver-side signature check is possible.
 *  - With the fake driver, an `https://example.com/...` URL passes the §4.3 save-time checks.
 *  - Deliveries need a worker on the `webhooks-out` queue (compose: a `queue` service listening on it; locally
 *    `php artisan queue:work --queue=webhooks-out`), or a sync queue.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DEV_PATH = '/integrations/developer';
export const devUrl = () => `${urls.merchant}${DEV_PATH}`;
export const PLAIN_KEY = /^sp_live_[A-Za-z0-9]{40}$/;
export const PLAIN_KEY_IN_TEXT = /sp_live_[A-Za-z0-9]{40}/;
export const SECRET = /^whsec_[A-Za-z0-9]{32}$/;
export const API_VERSION = '2026-12-01';

export type Scope = 'orders:read' | 'orders:write' | 'products:read' | 'products:write' | 'inventory:read' | 'inventory:write' | 'customers:read';
/** §2.2 UI labels (Figma tags), used as checkbox names in the create-key modal. */
export const SCOPE_LABEL: Record<Scope, string> = {
  'orders:read': 'Orders · read',
  'orders:write': 'Orders · write',
  'products:read': 'Products',
  'products:write': 'Products · write',
  'inventory:read': 'Stock',
  'inventory:write': 'Stock · write',
  'customers:read': 'Customers · read',
};

export type EventType =
  | 'order.created' | 'order.confirmed' | 'order.cancelled' | 'order.paid' | 'shipment.updated' | 'shipment.delivered'
  | 'return.received' | 'product.updated' | 'stock.low' | 'customer.created';

// ---------------------------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------------------------

/** Published throwaway commerce shop (`setupShop`) switched to `plan` (Growth has `api_webhooks`). Always `cleanup()`. */
export async function devShop(label: string, plan: 'free' | 'starter' | 'growth' = 'growth'): Promise<CommerceShop> {
  const shop = await setupShop(label);
  try {
    setPlan(shop.s, plan);
  } catch (e) {
    shop.cleanup();
    throw e;
  }
  return shop;
}

/** Storefront COD order (fires `order.created`); returns its merchant id and number. */
export async function storefrontOrder(shop: CommerceShop): Promise<{ id: string; number: string }> {
  const placed = await placeOrder(shop, shop.simple.variantId, 1);
  const number = placed.order.number as string;
  return { id: (placed.order.id as string | undefined) ?? (await orderIdByNumber(shop.s, number)), number };
}

/** Test-only: marks a delivery `failed` now (the real schedule takes ≈ 20.6 h, P84-9). Ids are validated first. */
export function forceDeliveryFailed(deliveryId: string): void {
  if (!/^[0-9a-z]{26}$/i.test(deliveryId)) throw new Error('bad id');
  tinker(
    `DB::table('webhook_deliveries')->where('id','${deliveryId}')->update(['status'=>'failed','next_attempt_at'=>null,'updated_at'=>now()]); echo 'ok';`,
  );
}

// ---------------------------------------------------------------------------------------------
// API keys (§6.1) + external API (§3)
// ---------------------------------------------------------------------------------------------

export async function createKey(s: Session, name: string, scopes: Scope[], includeCosts = false): Promise<{ key: Json; plain: string }> {
  const r = await api(s, 'POST', '/api-keys', { name, scopes, include_costs: includeCosts });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const plain = r.json.data.plain_key as string;
  expect(plain).toMatch(PLAIN_KEY);
  return { key: r.json.data as Json, plain };
}

export async function listKeys(s: Session): Promise<Json[]> {
  const r = await api(s, 'GET', '/api-keys');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** External API call (`/api/v1/external{path}`) straight to the API origin: no cookies, no CSRF, Bearer only. */
export function external(plain: string | null, method: string, path: string, o: { json?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers ?? {}) };
  if (plain !== null) headers.Authorization = `Bearer ${plain}`;
  if (o.json !== undefined) headers['Content-Type'] = 'application/json';
  return rawFetch(`${urls.api}/api/v1/external${path}`, { method, headers, body: o.json === undefined ? undefined : JSON.stringify(o.json) });
}

/** A syntactically valid key that was never issued (S101: same 401 body as a revoked one). */
export const fakePlainKey = () => `sp_live_${'Z'.repeat(8)}${unique('').replace(/[^A-Za-z0-9]/g, 'x').padEnd(32, 'Q').slice(0, 32)}`;

// ---------------------------------------------------------------------------------------------
// Webhooks (§4, §6.1) + fake sink (§4.3)
// ---------------------------------------------------------------------------------------------

/** A unique fake-sink URL for this run. `suffix` `/fail-503` → the fake answers 503 (§4.3). */
export const sinkUrl = (tag: string, suffix = '') => `https://example.com/storeplix-e2e/${tag}${suffix}`;

export async function createEndpoint(s: Session, url: string, events: EventType[], description: string | null = null): Promise<Json> {
  const r = await api(s, 'POST', `/stores/${s.storeId}/webhook-endpoints`, { url, events, description });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data as Json;
}

export async function endpoints(s: Session): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/webhook-endpoints`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

export async function revealSecret(s: Session): Promise<string> {
  const r = await api(s, 'POST', `/stores/${s.storeId}/webhook-secret/reveal`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const secret = r.json.data.secret as string;
  expect(secret).toMatch(SECRET);
  return secret;
}

export async function rotateSecret(s: Session): Promise<string> {
  const r = await api(s, 'POST', `/stores/${s.storeId}/webhook-secret/rotate`, {});
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.data.secret).toMatch(SECRET);
  return r.json.data.secret as string;
}

export async function deliveries(s: Session, query = ''): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/webhook-deliveries${query ? `?${query}` : ''}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

export async function delivery(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/webhook-deliveries/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

/** Polls the deliveries list (one endpoint) until one matches. The worker on `webhooks-out` must be running. */
export async function waitDelivery(s: Session, endpointId: string, pred: (d: Json) => boolean, timeout = 45_000): Promise<Json> {
  let last: Json[] = [];
  await expect
    .poll(async () => {
      last = await deliveries(s, `filter[endpoint_id]=${endpointId}`);
      return last.some(pred);
    }, { timeout, intervals: [500, 1_000, 2_000], message: 'webhook delivery (is a worker running on webhooks-out?)' })
    .toBe(true);
  return last.find(pred)!;
}

export interface SinkEntry {
  url: string;
  headers: Record<string, string>;
  body: string;
  raw: Json;
}

/** Lower-cased, single-valued headers. */
function normHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}

export async function sink(s: Session): Promise<SinkEntry[]> {
  const r = await api(s, 'GET', '/dev/webhook-sink');
  expect(r.status, `dev sink (WEBHOOKS_OUT_FAKE=true?) ${JSON.stringify(r.json)}`).toBe(200);
  return ((r.json.data ?? []) as Json[]).map((e) => {
    const body = typeof e.raw_body === 'string' ? e.raw_body : typeof e.body === 'string' ? e.body : null;
    expect(body, `sink entry must carry the raw body string: ${JSON.stringify(e).slice(0, 300)}`).not.toBeNull();
    return { url: String(e.url), headers: normHeaders(e.headers ?? e.request_headers), body: body!, raw: e };
  });
}

/** Sink requests to `url` (exact), optionally filtered further. */
export async function waitSink(s: Session, url: string, pred: (e: SinkEntry) => boolean = () => true, timeout = 45_000): Promise<SinkEntry[]> {
  let hits: SinkEntry[] = [];
  await expect
    .poll(async () => {
      hits = (await sink(s)).filter((e) => e.url === url && pred(e));
      return hits.length;
    }, { timeout, intervals: [500, 1_000, 2_000], message: `fake sink request to ${url}` })
    .toBeGreaterThan(0);
  return hits;
}

/** Parses `t=<unix>,v1=<hex>[,v1=<hex>]` (P84-8). */
export function parseSignature(header: string): { t: string; v1: string[] } {
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
  const v1 = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  return { t, v1 };
}

/** The documented receiver check: hex HMAC-SHA256(secret, "<t>.<raw body>"). */
export function sign(secret: string, t: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
}

/** True when any `v1` in the header equals the expected signature for `secret` (constant-time compare). */
export function verifies(header: string, rawBody: string, secret: string): boolean {
  const { t, v1 } = parseSignature(header);
  if (!/^\d+$/.test(t)) return false;
  const want = Buffer.from(sign(secret, t, rawBody), 'hex');
  return v1.some((h) => /^[0-9a-f]{64}$/.test(h) && timingSafeEqual(Buffer.from(h, 'hex'), want));
}

// ---------------------------------------------------------------------------------------------
// Developer page (§7) selectors
// ---------------------------------------------------------------------------------------------

export async function openDeveloper(page: Page): Promise<void> {
  await page.goto(devUrl());
  await expect(page.getByRole('heading', { name: /Developer/, level: 1 })).toBeVisible();
}

/** A card, labelled by its heading ("API keys", "Webhooks", "Signing secret", "Recent deliveries", …). */
export const devCard = (page: Page, name: string): Locator => page.getByLabel(name, { exact: true });
export const planNote = (page: Page): Locator => page.getByRole('note').filter({ hasText: /Growth plan/ });
export const createKeyButton = (page: Page): Locator => page.getByRole('button', { name: /Create API key/ }).first();
export const addEndpointButton = (page: Page): Locator => page.getByRole('button', { name: /Add endpoint/ }).first();
export const rowOf = (card: Locator, text: string | RegExp): Locator => card.getByRole('row').filter({ hasText: text });
/** Row menu trigger, same convention as Staff (`Actions for <name>`). */
export const rowMenu = (row: Locator): Locator => row.getByRole('button', { name: /^Actions for/ });
