import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { api, LARAVEL_LOG, tinker, urls, type Session } from './api';
import { orderIdByNumber, placeOrder, randomPhone, transition, type CommerceShop } from './commerce';
import { campaignShop, digits, sink, type CampaignShop, type SinkMessage } from './campaigns';

/**
 * Phase 8.6 helpers (PHASE-8-6-CONTRACT §3–§10, §13 QA): automations API (§9.1), run log, the scheduler commands run
 * on demand (`automations:detect-abandoned`, `automations:resume-due`), the shared campaign dev sink filtered to
 * automation messages (`automation_id`, §8), the storefront cart-contact / cart-restore paths (§7) and the
 * Automations UI selectors (one helper per label, so a renamed label is fixed in one place).
 *
 * ASSUMPTIONS on not-yet-built pieces (the builders must match them or tell QA; fixed at the gate otherwise):
 *  - `settings` is the recipe's parameter object (contract §11.1 C1), nested by step: checkout_recovery
 *    `{delay_minutes, step1: {enabled, message}, wait_hours, step2: {enabled, coupon_id, message}, exit_days, skip_risky}`,
 *    thank_you `{delay_hours, message, conditions}`, vip_tag `{min_delivered, tag, message: {enabled, …}, coupon_id}`,
 *    return_flag `{tag}`, low_stock `{}`. PATCH replaces the whole settings object (C1); `patchSettings()` deep-merges the
 *    change into the current settings and sends the whole object.
 *  - Conditions (§5, C2) live in `settings.conditions` as `[{field, op, value}]` for thank_you only; vip_tag's
 *    `min_delivered` is the derived `customer.delivered_orders_count gte` condition.
 *  - Dev sink entries of automation messages carry `automation_id` (§8, `DevSinkMessage.automation_id`); the recovery
 *    SMS carries `{cart_link}` = `https://{primary host}/r/{code}` (10 base62) and the 8.5 `STOP: {host}/u/{code}` footer.
 *  - The run log `GET /automation-runs?filter[automation_id]=` (contract C7) answers newest first, `AutomationRun` per §9.2 with `steps[]`
 *    (`index, action, status, reason, channel, masked_address, parts, detail, executed_at`).
 *  - Workers: a `queue:work` on `automations` (and `campaigns`, `notifications`) must run, as in compose.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const AUTOMATIONS = '/marketing/automations';
export const RUN_LOG = '/marketing/automations/runs';
export const RECOVERY = '/marketing/automations/checkout-recovery';
export const RECIPES = ['checkout_recovery', 'thank_you', 'vip_tag', 'return_flag', 'low_stock'] as const;
export type Recipe = (typeof RECIPES)[number];
export const CART_LINK = /\/r\/([A-Za-z0-9]{10})(?![A-Za-z0-9])/;
const ULID = /^[0-9a-z]{26}$/i;

export type AutomationShop = CampaignShop;

/** Throwaway published shop on `plan` whose local hour is `localHour` (13 = outside quiet hours, 2 = inside). */
export const automationShop = (label: string, plan: 'free' | 'starter' | 'growth' = 'starter', localHour = 13): Promise<AutomationShop> =>
  campaignShop(label, plan, localHour);

// ---------------------------------------------------------------------------------------------
// Automations API (§9.1)
// ---------------------------------------------------------------------------------------------

export const apath = (s: Session, rest = '') => `/stores/${s.storeId}/automations${rest}`;

export async function listAutomations(s: Session): Promise<{ data: Json[]; meta: Json }> {
  const r = await api(s, 'GET', apath(s));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data as Json[], meta: (r.json.meta ?? {}) as Json };
}

export const createAutomationRaw = (s: Session, recipe: string) => api(s, 'POST', apath(s), { recipe });

export async function createAutomation(s: Session, recipe: Recipe): Promise<Json> {
  const r = await createAutomationRaw(s, recipe);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  expect(r.json.data.status).toBe('draft');
  return r.json.data as Json;
}

export async function getAutomation(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', apath(s, `/${id}`));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
function deepMerge(base: Json, change: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(change)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/** PATCH with the current revision; `change` is deep-merged into the current settings. */
export async function patchSettings(s: Session, id: string, change: Json, name?: string): Promise<Json> {
  const cur = await getAutomation(s, id);
  const body: Json = { revision: cur.revision, settings: deepMerge((cur.settings ?? {}) as Json, change) };
  if (name) body.name = name;
  const r = await api(s, 'PATCH', apath(s, `/${id}`), body);
  expect(r.status, `PATCH settings ${JSON.stringify(change)} → ${JSON.stringify(r.json)}`).toBe(200);
  return r.json.data as Json;
}

export const enableRaw = (s: Session, id: string) => api(s, 'POST', apath(s, `/${id}/enable`), {});
export const disableRaw = (s: Session, id: string) => api(s, 'POST', apath(s, `/${id}/disable`), {});

export async function enable(s: Session, id: string): Promise<Json> {
  const r = await enableRaw(s, id);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.data.status).toBe('on');
  return r.json.data as Json;
}

/** Create (draft, defaults) → optional settings change → enable. */
export async function startRecipe(s: Session, recipe: Recipe, change: Json = {}): Promise<Json> {
  const a = await createAutomation(s, recipe);
  if (Object.keys(change).length) await patchSettings(s, a.id, change);
  return enable(s, a.id);
}

// ---------------------------------------------------------------------------------------------
// Run log (§9.1 `/automation-runs`)
// ---------------------------------------------------------------------------------------------

export async function runs(s: Session, query = ''): Promise<Json[]> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/automation-runs${query ? `?${query}` : ''}`);
  if (r.status !== 200) return []; // local sqlite "database is locked": the caller polls
  return r.json.data as Json[];
}

export const runsOf = (s: Session, automationId: string) => runs(s, `filter[automation_id]=${automationId}`);

/**
 * Polls the run log of one automation until `count` runs satisfy `pred` (a worker on the `automations` queue must
 * run). Returns those runs, newest first.
 */
export async function waitRuns(s: Session, automationId: string, pred: (r: Json) => boolean, count = 1, timeout = 60_000): Promise<Json[]> {
  let hit: Json[] = [];
  let seen: Json[] = [];
  await expect
    .poll(
      async () => {
        seen = await runsOf(s, automationId);
        hit = seen.filter(pred);
        return hit.length;
      },
      { timeout, intervals: [500, 1_000, 2_000], message: `automation ${automationId}: ${count} matching run(s) (worker on the automations queue?)` },
    )
    .toBeGreaterThanOrEqual(count);
  test.info().annotations.push({ type: 'runs', description: seen.map((r) => `${r.status}/${r.outcome_reason ?? '-'}`).join(', ') });
  return hit;
}

export const waitRun = async (s: Session, automationId: string, pred: (r: Json) => boolean, timeout = 60_000) =>
  (await waitRuns(s, automationId, pred, 1, timeout))[0];

export const stepAt = (run: Json, index: number): Json | undefined => (run.steps as Json[] | undefined)?.find((x) => x.index === index);
export const messageSteps = (run: Json): Json[] => ((run.steps ?? []) as Json[]).filter((x) => x.action === 'send_message');

// ---------------------------------------------------------------------------------------------
// Scheduler commands + test-only clock moves (tinker; ids validated before interpolation)
// ---------------------------------------------------------------------------------------------

function artisan(command: string, params: Json = {}): string {
  if (!/^automations:[a-z-]+$/.test(command)) throw new Error('bad command');
  const out = tinker(`Illuminate\\Support\\Facades\\Artisan::call('${command}', json_decode('${JSON.stringify(params)}', true)); echo 'ran:'.Illuminate\\Support\\Facades\\Artisan::output();`);
  expect(out, `${command}: ${out}`).toContain('ran:');
  return out;
}

export const detectAbandoned = () => artisan('automations:detect-abandoned');
export const resumeDue = () => artisan('automations:resume-due');

/** Moves the shop's captured-contact carts' last activity `minutes` into the past (the 15-min delay elapses). */
export function ageContactCarts(storeId: string, minutes = 20): string {
  if (!ULID.test(storeId)) throw new Error('bad id');
  return tinker(
    `echo 'aged:'.DB::table('carts')->where('store_id','${storeId.toLowerCase()}')->where('status','active')->whereNotNull('contact_phone')->update(['last_activity_at'=>now()->subMinutes(${Math.trunc(minutes)})]);`,
  );
}

/** Test-only: the captured contact of a cart (never returned by any endpoint, §7). */
export function cartContact(cartToken: string): Json | null {
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(cartToken)) throw new Error('bad token');
  const out = tinker(
    `$c=DB::table('carts')->where('token_hash',hash('sha256','${cartToken}'))->first(['id','status','contact_phone','contact_name','contact_email','contact_captured_at','recovery_detected_at']); echo 'CART:'.json_encode($c);`,
  );
  const m = out.match(/CART:(.*)$/m);
  return m && m[1] !== 'null' ? (JSON.parse(m[1]) as Json) : null;
}

/** Test-only: carts of a store with a captured contact (by phone digits). */
export function contactCarts(storeId: string): Json[] {
  if (!ULID.test(storeId)) throw new Error('bad id');
  const out = tinker(
    `echo 'CARTS:'.json_encode(DB::table('carts')->where('store_id','${storeId.toLowerCase()}')->whereNotNull('contact_phone')->get(['id','status','contact_phone','contact_name','recovery_detected_at','last_activity_at']));`,
  );
  const m = out.match(/CARTS:(.*)$/m);
  return m ? (JSON.parse(m[1]) as Json[]) : [];
}

/** Moves a waiting run's `resume_at` into the past and runs `automations:resume-due` (a wait/quiet-hours window ends). */
export function elapseWait(runId: string): void {
  if (!ULID.test(runId)) throw new Error('bad id');
  tinker(`DB::table('automation_runs')->where('id','${runId.toLowerCase()}')->where('status','waiting')->update(['resume_at'=>now()->subMinute()]); echo 'ok';`);
  resumeDue();
}

// ---------------------------------------------------------------------------------------------
// Dev sink (8.5 §5.4 + 8.6 §8 `automation_id`)
// ---------------------------------------------------------------------------------------------

export async function autoSink(s: Session, automationId: string, phone?: string): Promise<SinkMessage[]> {
  for (let i = 0; i < 3; i++) {
    const probe = await api(s, 'GET', `/dev/stores/${s.storeId}/message-sink`);
    if (probe.status !== 500) break; // sqlite "database is locked" (local only): retry
    await new Promise((r) => setTimeout(r, 500));
  }
  return (await sink(s)).filter(
    (m) => (m.raw.automation_id ? m.raw.automation_id === automationId : !m.campaignId) && (!phone || digits(m.to) === digits(phone)),
  );
}

export const cartCode = (m: SinkMessage): string | null => m.text.match(CART_LINK)?.[1] ?? null;

// ---------------------------------------------------------------------------------------------
// Commerce shortcuts
// ---------------------------------------------------------------------------------------------

/** A storefront COD order by `phone` taken to `delivered` through the merchant API (manual ship creates a shipment, so
 *  `shipment.delivered` → `order.delivered` fires). Returns the merchant order id + number. */
export async function deliveredOrder(shop: CommerceShop, phone = randomPhone(), name = 'Rahim Uddin', variantId = shop.simple.variantId): Promise<{ id: string; number: string; phone: string }> {
  const placed = await placeOrder(shop, variantId, 1, { body: { contact: { name, phone, email: null } } });
  const id = await orderIdByNumber(shop.s, placed.order.number);
  for (const step of ['confirm', 'ready', 'ship', 'deliver'] as const) {
    const body = step === 'ship' ? { carrier_name: 'Steadfast', tracking_code: `QA-${placed.order.number}` } : {};
    let r = await transition(shop.s, id, step, body);
    // Local sqlite only: "database is locked" 500 under the worker's writes → retry (the transition did not commit).
    for (let i = 0; i < 3 && r.status === 500 && /database is locked/.test(JSON.stringify(r.json)); i++) {
      await new Promise((res) => setTimeout(res, 700));
      r = await transition(shop.s, id, step, body);
    }
    expect(r.status, `${step}: ${JSON.stringify(r.json)}`).toBe(200);
  }
  return { id, number: placed.order.number, phone };
}

/** Return request on a delivered order → approve → receive (fires `return.received`). */
export async function receivedReturn(s: Session, orderId: string): Promise<string> {
  const order = await api(s, 'GET', `/stores/${s.storeId}/orders/${orderId}`);
  const item = order.json.data.items[0] as Json;
  const created = await api(s, 'POST', `/stores/${s.storeId}/orders/${orderId}/returns`, { type: 'return', reason: 'damaged', lines: [{ order_item_id: item.id, quantity: 1 }] });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.data.id as string;
  const approved = await api(s, 'POST', `/stores/${s.storeId}/returns/${id}/approve`, {});
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  const lines = (created.json.data.items ?? created.json.data.lines ?? []) as Json[];
  const received = await api(s, 'POST', `/stores/${s.storeId}/returns/${id}/receive`, {
    checks: { tags_intact: true, unused: true, original_packaging: true },
    lines: lines.length ? lines.map((l) => ({ return_item_id: l.id, restock_quantity: 0 })) : [{ order_item_id: item.id, quantity: 1, restock_quantity: 0 }],
  });
  expect(received.status, JSON.stringify(received.json)).toBe(200);
  return id;
}

/** Manual stock adjustment (delta) through the merchant API. */
export async function adjustStock(s: Session, variantId: string, delta: number): Promise<void> {
  const r = await api(s, 'POST', `/stores/${s.storeId}/inventory/adjustments`, {
    reason: delta > 0 ? 'received' : 'damaged',
    items: [{ variant_id: variantId, mode: 'delta', quantity: delta }],
  });
  expect([200, 201], JSON.stringify(r.json)).toContain(r.status);
}

/** Customer by phone digits (storefront orders create/link it). */
export async function customerOf(s: Session, phone: string): Promise<Json | undefined> {
  const r = await api(s, 'GET', `/stores/${s.storeId}/customers?q=${encodeURIComponent(phone)}&per_page=50`);
  return ((r.json.data ?? []) as Json[]).find((c) => digits(String(c.phone ?? '')) === digits(phone));
}

/** A mail (MAIL_MAILER=log) to `to` appended to laravel.log after `mark` whose entry matches `needle`. */
export function loggedMail(to: string, mark: number, needle: RegExp): string | null {
  if (!existsSync(LARAVEL_LOG)) return null;
  const buf = readFileSync(LARAVEL_LOG);
  const tail = buf.subarray(Math.min(mark, buf.length)).toString('utf8');
  return tail.split(/\n(?=\[\d{4}-\d{2}-\d{2} )/).find((e) => e.includes(`To: ${to}`) && needle.test(e)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// UI (§10)
// ---------------------------------------------------------------------------------------------

export const mUrl = (path = '') => `${urls.merchant}${path}`;
export const automationsPlanNote = (page: Page): Locator => page.getByText(/Automations are part of the Starter plan/).first();
export const pausedPill = (page: Page): Locator => page.getByText(/Paused\s*[—-]\s*not in your plan/).first();
export const quietNote = (page: Page): Locator => page.getByText(/Quiet hours 9 PM\s*[–-]\s*9 AM/).first();
export const checkoutNotice = (page: Page): Locator => page.getByText(/If you don.t finish, we may text you a reminder/).first();

export async function openAutomations(page: Page): Promise<void> {
  await page.goto(mUrl(AUTOMATIONS));
  await expect(page.getByRole('heading', { name: /^Automations$/, level: 1 })).toBeVisible({ timeout: 15_000 });
}

/** Test-only: the stored `outcome_detail` of a run (not part of the §9.2 response shape). */
export function storedOutcomeDetail(runId: string): unknown {
  if (!ULID.test(runId)) throw new Error('bad id');
  const out = tinker(`echo 'DETAIL:'.json_encode(DB::table('automation_runs')->where('id','${runId.toLowerCase()}')->value('outcome_detail'));`);
  const m = out.match(/DETAIL:(.*)$/m);
  const v = m ? (JSON.parse(m[1]) as unknown) : null;
  return typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
}
