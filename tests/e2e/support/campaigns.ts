import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, apiCall, tinker, unique, urls, type ApiResult, type Session } from './api';
import { browserHost, placeOrder, rawFetch, setPlan, setupShop, sf, type CommerceShop } from './commerce';

/**
 * Phase 8.5 helpers (PHASE-8-5-CONTRACT §3–§8, §11 QA): campaigns API, audience preview, the campaign dev sink
 * (`CAMPAIGNS_DEV_SINK=true`), storefront unsubscribe (`/u/{code}`, §4.2/§8.6), store timezone control for quiet hours
 * (P85-15) and the Marketing UI selectors (one per helper, so a renamed label is fixed in one place).
 *
 * ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA):
 *  - Dev sink `GET /api/v1/dev/stores/{store}/message-sink` (merchant session, `perm:marketing.manage`) answers
 *    `{ data: Entry[] }` (order not relied on). Each entry carries `channel`, the recipient (`to`, or `address`), the
 *    rendered SMS text (`text`, or `body`) or the email `subject` + `text`/`html`, and `unsubscribe_url`. A
 *    `campaign_id` is used when present; otherwise entries are matched by a unique marker in the body. (ARCH's
 *    `DevSinkMessage` type: channel, to, subject, text, unsubscribe_url, campaign_id, is_test, created_at.)
 *  - The sink is a cache list: `setPlan` / `browserHost` flush the cache, so shops are fully set up before sending.
 *  - Quiet hours (21:00–09:00) are evaluated in the store timezone (`PATCH settings {region: {timezone}}`). Specs pick
 *    a fixed-offset zone so the store's local time is mid-day (or mid-night) whenever the suite runs.
 *  - Campaign jobs run on the `campaigns` queue: a worker must listen on it (or the queue is sync).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MARKETING = '/marketing';
export const CAMPAIGNS = '/marketing/campaigns';
export const UNSUB_CODE = /\/u\/([A-Za-z0-9]{10})(?![A-Za-z0-9])/;

// ---------------------------------------------------------------------------------------------
// Store timezone (P85-15 quiet hours are in store time)
// ---------------------------------------------------------------------------------------------

/** One DST-free IANA zone per whole-hour UTC offset (−11 … +14). All are in PHP's `timezone:all` list. */
const ZONE_BY_OFFSET: Record<number, string> = {
  [-11]: 'Pacific/Pago_Pago', [-10]: 'Pacific/Honolulu', [-9]: 'Pacific/Gambier', [-8]: 'Pacific/Pitcairn',
  [-7]: 'America/Phoenix', [-6]: 'America/Regina', [-5]: 'America/Panama', [-4]: 'America/La_Paz',
  [-3]: 'America/Argentina/Buenos_Aires', [-2]: 'America/Noronha', [-1]: 'Atlantic/Cape_Verde', 0: 'Africa/Abidjan',
  1: 'Africa/Lagos', 2: 'Africa/Johannesburg', 3: 'Europe/Moscow', 4: 'Asia/Dubai', 5: 'Asia/Karachi', 6: 'Asia/Dhaka',
  7: 'Asia/Bangkok', 8: 'Asia/Singapore', 9: 'Asia/Tokyo', 10: 'Australia/Brisbane', 11: 'Pacific/Guadalcanal',
  12: 'Pacific/Tarawa', 13: 'Pacific/Fakaofo', 14: 'Pacific/Kiritimati',
};

/** A zone where the local wall-clock hour is `hour` right now. */
export function zoneForLocalHour(hour: number, now = new Date()): { zone: string; offset: number } {
  let offset = (((hour - now.getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  return { zone: ZONE_BY_OFFSET[offset], offset };
}

/** Local wall-clock `HH:MM` of `at` in a fixed `offset` zone. */
export function localTime(at: Date, offset: number): string {
  const d = new Date(at.getTime() + offset * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The instant of local `HH:MM` on the local day of `now` (+ `dayShift`) in a fixed `offset` zone, ISO-8601 UTC. */
export function atLocal(offset: number, hhmm: string, dayShift = 0, now = new Date()): string {
  const local = new Date(now.getTime() + offset * 3_600_000);
  const [h, m] = hhmm.split(':').map(Number);
  const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift, h, m) - offset * 3_600_000;
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function setStoreTimezone(s: Session, zone: string): Promise<void> {
  const r = await api(s, 'PATCH', `/stores/${s.storeId}/settings`, { region: { timezone: zone } });
  expect(r.status, `set timezone ${zone}: ${JSON.stringify(r.json)}`).toBe(200);
}

// ---------------------------------------------------------------------------------------------
// Shops + customers
// ---------------------------------------------------------------------------------------------

export interface CampaignShop extends CommerceShop {
  /** store display name (SMS prefix `"{name}: "`, P85-18) */
  name: string;
  /** store tz offset in hours (fixed-offset zone) */
  offset: number;
  zone: string;
}

/**
 * Published throwaway shop on `plan`, browsable on `{slug}.localhost`, with the store timezone set so its local hour is
 * `localHour` (13 → mid-day, outside quiet hours; 2 → inside). Always `cleanup()`.
 */
export async function campaignShop(label: string, plan: 'free' | 'starter' | 'growth' = 'starter', localHour = 13): Promise<CampaignShop> {
  const shop = await setupShop(label);
  try {
    setPlan(shop.s, plan);
    browserHost(shop);
    const { zone, offset } = zoneForLocalHour(localHour);
    await setStoreTimezone(shop.s, zone);
    const st = await api(shop.s, 'GET', `/stores/${shop.s.storeId}`);
    expect(st.status).toBe(200);
    return { ...shop, name: String(st.json.data.name), zone, offset };
  } catch (e) {
    shop.cleanup();
    throw e;
  }
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  accepts_marketing?: boolean;
  tags?: string[];
  district?: string | null;
}

export async function addCustomer(s: Session, c: CustomerInput): Promise<Json> {
  const r = await api(s, 'POST', `/stores/${s.storeId}/customers`, c);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.data as Json;
}

export async function getCustomer(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/customers/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

export async function customerByPhone(s: Session, phone: string): Promise<Json | undefined> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/customers?q=${encodeURIComponent(phone)}&per_page=50`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.data as Json[]).find((c) => digits(String(c.phone ?? '')) === digits(phone));
}

/** A storefront COD order by `phone` (creates/links the customer with `orders_count ≥ 1`, P85-3). */
export async function orderAs(shop: CommerceShop, name: string, phone: string): Promise<Json> {
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name, phone, email: null } } });
  return placed.order as Json;
}

/** Last 10 digits: compares `017…`, `88017…`, `+880 17…`. */
export const digits = (phone: string) => phone.replace(/\D/g, '').slice(-10);

// ---------------------------------------------------------------------------------------------
// Campaigns API (§6.1)
// ---------------------------------------------------------------------------------------------

export type Channel = 'sms' | 'email';
export const ALL: Json = { segment: 'all', params: {}, exclude: { risky: false, ordered_within_days: null } };

export interface CampaignInput {
  name?: string;
  channel?: Channel;
  language?: 'bn' | 'en';
  audience?: Json;
  body?: string;
  subject?: string | null;
  coupon_id?: string | null;
  product_id?: string | null;
  scheduled_at?: string | null;
}

const cpath = (s: Session, rest = '') => `/stores/${s.storeId}/campaigns${rest}`;

export function createCampaignRaw(s: Session, input: CampaignInput): Promise<{ status: number; json: Json }> {
  return api(s, 'POST', cpath(s), { name: unique('QA campaign '), channel: 'sms', language: 'en', audience: ALL, ...input });
}

export async function createCampaign(s: Session, input: CampaignInput): Promise<Json> {
  const r = await createCampaignRaw(s, input);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(r.json.data.status).toBe('draft');
  return r.json.data as Json;
}

export async function getCampaign(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', cpath(s, `/${id}`));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

/** `POST …/send` or `…/schedule` with a fresh `Idempotency-Key` (required, §6.1). */
export async function sendNow(s: Session, id: string, key: string | null = randomUUID()): Promise<ApiResult> {
  let r = await apiCall(s, 'POST', cpath(s, `/${id}/send`), { json: {}, headers: key ? { 'Idempotency-Key': key } : {} });
  // Local sqlite only: "database is locked" 500 → retry with the same key (the endpoint is idempotent).
  for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(r.text); i++) {
    await new Promise((res) => setTimeout(res, 700));
    r = await apiCall(s, 'POST', cpath(s, `/${id}/send`), { json: {}, headers: key ? { 'Idempotency-Key': key } : {} });
  }
  return r;
}

export function schedule(s: Session, id: string, scheduledAt: string, key: string | null = randomUUID()): Promise<ApiResult> {
  return apiCall(s, 'POST', cpath(s, `/${id}/schedule`), { json: { scheduled_at: scheduledAt }, headers: key ? { 'Idempotency-Key': key } : {} });
}

export const cancel = (s: Session, id: string) => api(s, 'POST', cpath(s, `/${id}/cancel`), {});
export const unschedule = (s: Session, id: string) => api(s, 'POST', cpath(s, `/${id}/unschedule`), {});
export const testSend = (s: Session, id: string) => api(s, 'POST', cpath(s, `/${id}/test`), {});
export const audiencePreview = (s: Session, channel: Channel, audience: Json = ALL) => api(s, 'POST', cpath(s, '/audience-preview'), { channel, audience });
export const estimate = (s: Session, body: Json) => api(s, 'POST', cpath(s, '/estimate'), body);

export async function listCampaigns(s: Session, query = ''): Promise<Json[]> {
  const r = await api(s, 'GET', cpath(s, query ? `?${query}` : ''));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json[];
}

/** Polls until the campaign reaches one of `statuses` (a worker on the `campaigns` queue must run). */
/**
 * Test-only: runs `campaigns:dispatch-due` with `resume_after_minutes = 0`, resuming a `sending` campaign whose batch
 * job was lost (on local sqlite a SendCampaignBatch can die on "database is locked"; tries = 1 by design, P85-11) instead
 * of waiting the 2-minute idle window.
 */
export function kickDispatchDue(): void {
  tinker("config(['campaigns.resume_after_minutes' => 0]); Illuminate\\Support\\Facades\\Artisan::call('campaigns:dispatch-due'); echo 'ok';");
}

export async function waitCampaign(s: Session, id: string, statuses: string[] = ['sent'], timeout = 90_000): Promise<Json> {
  let last: Json = {};
  const started = Date.now();
  let kicked = 0;
  await expect
    .poll(async () => {
      if (Date.now() - started > 20_000 + kicked * 15_000 && last.status === 'sending') {
        kicked++;
        kickDispatchDue();
        test.info().annotations.push({ type: 'dispatch-due kick', description: `campaign ${id} still sending after ${Math.round((Date.now() - started) / 1000)} s` });
      }
      // Local sqlite stacks answer 500 "database is locked" under load (TESTING.md): keep polling instead of failing.
      const r = await api(s, 'GET', cpath(s, `/${id}`));
      if (r.status !== 200) return `http ${r.status}`;
      last = r.json.data as Json;
      return statuses.includes(last.status) || ['failed', 'cancelled'].includes(last.status) ? last.status : `…${last.status}`;
    }, { timeout, intervals: [500, 1_000, 2_000], message: `campaign ${id} → ${statuses.join('|')} (is a worker running on the campaigns queue?)` })
    .toMatch(new RegExp(`^(${statuses.join('|')})$`));
  return last;
}

export async function recipients(s: Session, id: string, query = ''): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const q = [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&');
    const r = await api(s, 'GET', cpath(s, `/${id}/recipients${q ? `?${q}` : ''}`));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    out.push(...(r.json.data as Json[]));
    cursor = (r.json.meta?.next_cursor as string | null | undefined) ?? null;
    if (!cursor) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Consent (§4.1)
// ---------------------------------------------------------------------------------------------

export const optOut = (s: Session, customerId: string, channel: Channel) =>
  api(s, 'POST', `/stores/${s.storeId}/customers/${customerId}/marketing-opt-out`, { channel });
export const removeOptOut = (s: Session, customerId: string, channel: Channel) =>
  api(s, 'DELETE', `/stores/${s.storeId}/customers/${customerId}/marketing-opt-out/${channel}`);

// ---------------------------------------------------------------------------------------------
// Dev sink (§5.4)
// ---------------------------------------------------------------------------------------------

export interface SinkMessage {
  channel: string;
  to: string;
  text: string;
  subject: string | null;
  unsubscribeUrl: string | null;
  code: string | null;
  campaignId: string | null;
  isTest: boolean;
  raw: Json;
}

export async function sink(s: Session): Promise<SinkMessage[]> {
  const r = await api(s, 'GET', `/dev/stores/${s.storeId}/message-sink`);
  expect(r.status, `campaign dev sink (CAMPAIGNS_DEV_SINK=true?) ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  return ((r.json.data ?? []) as Json[]).map((e) => {
    const text = String(e.text ?? e.body ?? e.rendered ?? e.html ?? '');
    const url = (e.unsubscribe_url as string | undefined) ?? text.match(/\S+\/u\/[A-Za-z0-9]{10}(?![A-Za-z0-9])/)?.[0] ?? null;
    return {
      channel: String(e.channel ?? ''),
      to: String(e.to ?? e.address ?? e.recipient ?? ''),
      text,
      subject: (e.subject as string | undefined) ?? null,
      unsubscribeUrl: url,
      code: url?.match(UNSUB_CODE)?.[1] ?? null,
      campaignId: (e.campaign_id as string | undefined) ?? null,
      isTest: e.is_test === true,
      raw: e,
    };
  });
}

/** Sink messages of one campaign: by `campaign_id` when the sink has it, else by a unique `marker` in the body. */
export async function sinkFor(s: Session, campaignId: string, marker: string): Promise<SinkMessage[]> {
  for (let i = 0; i < 3; i++) {
    const probe = await api(s, 'GET', `/dev/stores/${s.storeId}/message-sink`);
    if (probe.status !== 500) break; // sqlite "database is locked" (local only): retry
    await new Promise((r) => setTimeout(r, 500));
  }
  return (await sink(s)).filter((m) => (m.campaignId ? m.campaignId === campaignId : m.text.includes(marker)));
}

// ---------------------------------------------------------------------------------------------
// Storefront unsubscribe (§4.2 API, §8.6 page)
// ---------------------------------------------------------------------------------------------

/** `GET /api/v1/storefront/unsubscribe/{code}` as the storefront server calls it. */
export const unsubApi = (host: string, code: string) => sf(host, 'GET', `/unsubscribe/${code}`);
export const unsubPost = (host: string, code: string, action: 'unsubscribe' | 'resubscribe', oneClick = false) =>
  sf(host, 'POST', `/unsubscribe/${code}`, { json: { action, ...(oneClick ? { one_click: true } : {}) } });

/** RFC 8058 one-click POST to the storefront route handler (`/u/{code}/one-click`). */
export const oneClick = (shop: CommerceShop, code: string) =>
  rawFetch(`${shop.storefront}/u/${code}/one-click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });

export const unsubPage = (shop: CommerceShop, code: string) => `${shop.storefront}/u/${code}`;

// ---------------------------------------------------------------------------------------------
// Marketing UI (§8) selectors
// ---------------------------------------------------------------------------------------------

export const mUrl = (path = '') => `${urls.merchant}${path}`;

export async function openOverview(page: Page): Promise<void> {
  await page.goto(mUrl(MARKETING));
  await expect(page.getByRole('heading', { name: /^Marketing$/, level: 1 })).toBeVisible();
}

export async function openComposer(page: Page): Promise<void> {
  await page.goto(mUrl(`${CAMPAIGNS}/new`));
  await expect(page.getByRole('button', { name: /Save draft/ })).toBeVisible({ timeout: 15_000 });
}

/** A ChoiceCard / chip / radio-like control by its name (radio first, then button). */
export const choice = (scope: Page | Locator, name: RegExp): Locator =>
  scope.getByRole('radio', { name }).or(scope.getByRole('button', { name })).first();

export const planNote = (page: Page): Locator => page.getByText(/Campaigns are part of the Starter plan/).first();
export const newCampaignButton = (page: Page): Locator =>
  page.getByRole('link', { name: /New campaign/ }).or(page.getByRole('button', { name: /New campaign/ })).first();
export const messageBox = (page: Page): Locator => page.getByRole('textbox', { name: /Message/i }).first();
export const nameBox = (page: Page): Locator => page.getByRole('textbox', { name: /Campaign name|^Name/i }).first();
export const recentOrderSkip = (page: Page): Locator => page.getByRole('checkbox', { name: /ordered in the last/i }).first();
export const riskySkip = (page: Page): Locator => page.getByRole('checkbox', { name: /Skip risky/i }).first();
export const optedOutRow = (page: Page): Locator => page.getByRole('checkbox', { name: /Opted-out customers are never messaged/i }).first();
export const willGet = (page: Page): Locator => page.getByText(/customers? will get this message/i).first();
/** Primary composer action: "Send campaign" with Send now, "Schedule campaign" with Schedule (§8.3). */
export const primaryAction = (page: Page): Locator => page.getByRole('button', { name: /^(Send|Schedule) campaign$/ }).first();

/** Fills the composer for an SMS/email campaign to the given segment option, "Send now" (no submit). */
export async function fillComposer(page: Page, o: { name: string; channel: Channel; body: string; subject?: string; english?: boolean; skipRecent?: boolean }): Promise<void> {
  await nameBox(page).fill(o.name);
  await choice(page, o.channel === 'sms' ? /^SMS/ : /^Email/).click();
  if (o.english !== false) await choice(page, /^English$/).click();
  const recent = recentOrderSkip(page);
  if (o.skipRecent === false && (await recent.count()) && (await recent.isChecked())) await recent.uncheck();
  if (o.subject !== undefined) await page.getByRole('textbox', { name: /Subject/i }).first().fill(o.subject);
  await messageBox(page).fill(o.body);
  await choice(page, /^Send now$/).click();
}

export const dialog = (page: Page): Locator => page.getByRole('dialog').last();
