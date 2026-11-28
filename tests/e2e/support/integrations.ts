import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { api, apiCall, tinker, unique, urls, type ApiResult, type Session } from './api';
import { png } from './catalog';
import { type CommerceShop } from './commerce';

/**
 * PHASE-8-9D (part A: tracking + product feeds; part B: Nagad, AI credits, AI writer, AI photos). Fake drivers only:
 * the API runs with TRACKING_FAKE=true FEEDS_FAKE=true PAYMENTS_FAKE=true AI_DRIVER=fake AI_IMAGE_DRIVER=fake and a
 * worker on the `tracking`, `feeds` and `ai` queues (see TESTING.md "Phase 8.9d"). No real provider is ever called.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * GET with a retry on the local-sqlite "database is locked" 500 (known local flake, TESTING.md; never on Postgres).
 * Only reads are retried, so a retry can never double a write.
 */
export async function getJson(s: Session, path: string): Promise<{ status: number; json: Json }> {
  let r = await api(s, 'GET', path);
  for (let i = 0; i < 4 && r.status === 500 && /database is locked/.test(JSON.stringify(r.json)); i++) {
    await new Promise((ok) => setTimeout(ok, 500 * (i + 1)));
    r = await api(s, 'GET', path);
  }
  return r;
}

export const ipath = (s: Session, provider: string, rest = '') => `/stores/${s.storeId}/integrations/${provider}${rest}`;

/** Valid-looking IDs (patterns from packages/types) and a token whose last 4 we can look for. */
export const META_PIXEL_ID = '128455670912334';
export const GA4_ID = 'G-7K2QX9M4LP';
export const PASTED_META_SNIPPET = "<!-- Meta Pixel Code --><script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js'); fbq('init', '128455670912334'); fbq('track', 'PageView');</script>";
export const token = (label: string) => `EAAqa${label}${unique('')}Tk${Math.random().toString(36).slice(2, 6)}`.replace(/[^A-Za-z0-9]/g, '');

export async function getIntegration(s: Session, provider: string): Promise<Json> {
  const r = await getJson(s, ipath(s, provider));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

export const putIntegrationRaw = (s: Session, provider: string, body: Json) => apiCall(s, 'PUT', ipath(s, provider), { json: body });

export async function putIntegration(s: Session, provider: string, body: Json): Promise<Json> {
  const r = await putIntegrationRaw(s, provider, body);
  expect(r.status, r.text.slice(0, 500)).toBe(200);
  return r.json.data;
}

export async function list(s: Session): Promise<Json[]> {
  const r = await getJson(s, `/stores/${s.storeId}/integrations`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

export async function events(s: Session, provider: string, query = ''): Promise<Json[]> {
  const r = await getJson(s, ipath(s, provider, `/events${query ? `?${query}` : ''}`));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** Waits until the purchase event of an order is final (sent / failed / skipped) on the `tracking` queue. */
export async function waitPurchase(s: Session, provider: string, orderId: string, timeout = 60_000): Promise<Json[]> {
  let rows: Json[] = [];
  await expect
    .poll(
      async () => {
        rows = (await events(s, provider)).filter((e) => e.event_id === `purchase.${orderId}` && e.channel === 'server');
        return rows.map((e) => e.status).join(',');
      },
      { timeout, message: `purchase.${orderId} delivered (is a worker on the \`tracking\` queue running?)` },
    )
    .toMatch(/^(sent|delivered)$/);
  return rows;
}

export async function disconnectRaw(s: Session, provider: string, confirm: string): Promise<ApiResult> {
  return apiCall(s, 'POST', ipath(s, provider, '/disconnect'), { json: { confirm } });
}

// ---------------------------------------------------------------------------------------------
// Feeds (fake OAuth: authorize_url = the API callback with code=fake-code; "issue" in a title → disapproved)
// ---------------------------------------------------------------------------------------------
export async function feedOverview(s: Session, provider: string): Promise<Json> {
  const r = await getJson(s, ipath(s, provider, '/feed'));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

export async function feedItems(s: Session, provider: string, query = ''): Promise<{ data: Json[]; meta: Json }> {
  const r = await getJson(s, ipath(s, provider, `/items${query ? `?${query}` : ''}`));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

export async function syncRuns(s: Session, provider: string): Promise<Json[]> {
  const r = await getJson(s, ipath(s, provider, '/sync-runs'));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** Rows of the store's catalog_items table (test-only read, to prove the disconnect deleted them). */
export function catalogItemCount(storeId: string): number {
  if (!/^[0-9a-z]{26}$/i.test(storeId)) throw new Error('bad id');
  const out = tinker(`echo DB::table('catalog_items')->where('store_id','${storeId.toLowerCase()}')->count();`);
  return Number(out.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------------------------
// Nagad (fake gateway; PEM keys are validated for real on save, so the spec makes a 2048-bit RSA pair)
// ---------------------------------------------------------------------------------------------
export function nagadKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

export const NAGAD_MERCHANT_ID = '683002007104225';

// ---------------------------------------------------------------------------------------------
// AI credits and tools
// ---------------------------------------------------------------------------------------------
export async function aiCredits(s: Session): Promise<Json> {
  const r = await getJson(s, '/billing/ai-credits');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

export async function aiLedger(s: Session, query = ''): Promise<Json[]> {
  const r = await getJson(s, `/billing/ai-credits/ledger${query ? `?${query}` : ''}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

export function describeRaw(s: Session, body: Json, key: string = randomUUID()): Promise<ApiResult> {
  return apiCall(s, 'POST', `/stores/${s.storeId}/ai/product-descriptions`, { json: body, headers: { 'Idempotency-Key': key } });
}

export async function generation(s: Session, id: string): Promise<Json> {
  const r = await getJson(s, `/stores/${s.storeId}/ai/generations/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data;
}

export async function waitGeneration(s: Session, id: string, timeout = 60_000): Promise<Json> {
  let g: Json = {};
  await expect
    .poll(
      async () => {
        g = await generation(s, id);
        return g.status;
      },
      { timeout, message: `generation ${id} finished (is a worker on the \`ai\` queue running?)` },
    )
    .toMatch(/^(succeeded|failed)$/);
  return g;
}

export async function turnOnAi(s: Session, provider: 'ai_writer' | 'ai_photos'): Promise<Json> {
  const cur = await getIntegration(s, provider);
  // only writable keys: ai_photos' defaults include the read-only keep_originals_days (P89D-QA-B2)
  if (cur.status === 'connected') return cur; // already On (e.g. turned on through the UI by an earlier test)
  const { keep_originals_days: _ro, ...settings } = (cur.defaults ?? {}) as Json; // eslint-disable-line @typescript-eslint/no-unused-vars
  // a row that was On before (disconnected) needs its revision, like the dashboard sends
  return putIntegration(s, provider, { settings, ...(cur.status === 'not_connected' ? {} : { revision: cur.revision }) });
}

/** Uploads a product image and waits until the media job made it `ready`. */
export async function readyImage(s: Session, rgb: [number, number, number] = [200, 60, 60]): Promise<string> {
  const r = await apiCall(s, 'POST', '/media', { multipart: { purpose: 'product_image', file: { name: `qa-ai-${unique('')}.png`, mimeType: 'image/png', buffer: png(640, rgb) } } });
  expect(r.status, r.text.slice(0, 300)).toBe(201);
  const id = r.json.data.id as string;
  await expect
    .poll(async () => (await getJson(s, `/media/${id}`)).json.data?.status, { timeout: 60_000, message: `media ${id} ready (worker on default,media?)` })
    .toBe('ready');
  return id;
}

export async function productImages(s: Session, productId: string): Promise<string[]> {
  const r = await getJson(s, `/stores/${s.storeId}/products/${productId}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.data.images as Json[]).map((i) => i.media_id as string);
}

// ---------------------------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------------------------
export const mUrl = (path: string) => `${urls.merchant}${path}`;

/** Records the method + path of every request the page sends to `pathPart` (to prove "no PUT was sent"). */
export function recordRequests(page: Page, pathPart: string): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes(pathPart)) seen.push(`${r.method()} ${u.pathname}`);
  });
  return seen;
}

/** Blocks the real third-party tag hosts so the storefront check never calls Meta / Google / TikTok. */
export async function blockTagHosts(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route(/(connect\.facebook\.net|googletagmanager\.com|google-analytics\.com|analytics\.tiktok\.com)/, (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  return blocked;
}

export async function noOverflow(page: Page, what: string): Promise<void> {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what}: page scrolls horizontally (${scroll} > ${inner})`).toBeLessThanOrEqual(inner + 1);
}

export type { CommerceShop };
