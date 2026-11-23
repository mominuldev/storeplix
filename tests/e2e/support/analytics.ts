import { expect, type Locator, type Page } from '@playwright/test';
import { tinker, type Session } from './api';
import { adminApi, adminUrl, type AdminSession } from './admin';
import { localDate } from './billing';
import { merchantOrder, orderIdByNumber } from './commerce';

/**
 * Phase 8.2 helpers (PHASE-8-2-CONTRACT §4.3, §6, §7.1, §10 QA). Platform analytics are computed from snapshot tables by
 * `analytics:aggregate`; the specs turn freshly created orders/payments into numbers with the testing-only
 * `POST /api/v1/dev/analytics/aggregate` (local/testing only, admin surface + super-admin session, 10/min).
 *
 * Every number the specs assert is computed from data the spec itself created (contract §3 definitions). Platform-wide
 * totals include every other shop in the local DB, so the specs assert **deltas** between two aggregate runs of the same
 * Dhaka day (flows are restated on a re-run, P82-5) plus exact per-tenant values.
 *
 * UI selectors were written before the WEB build existed: each lives in ONE helper below (marked "UI") so a label change
 * is a one-line fix. They follow the Figma labels in contract §7.1.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ANALYTICS_TZ = 'Asia/Dhaka';

/** Today as a Dhaka calendar date (`YYYY-MM-DD`). */
export const dhakaToday = (): string => localDate(new Date(), ANALYTICS_TZ);

/**
 * The specs aggregate "today" twice and compare: both runs must hit the same Dhaka day. If the Dhaka midnight
 * (18:00Z) is less than `minutes` away, wait until it has passed.
 */
export async function avoidDhakaMidnight(minutes = 4): Promise<void> {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18, 0, 0);
  const left = midnight - now.getTime();
  if (left > 0 && left < minutes * 60_000) await new Promise((r) => setTimeout(r, left + 5_000));
}

// ---------------------------------------------------------------------------------------------
// Testing-only aggregate endpoint (§4.3). Not in openapi. Contract path `POST /dev/analytics/aggregate` under /api/v1;
// the second candidate only covers an API that mounts it inside the admin prefix (proposed clarification in the QA report).
// ---------------------------------------------------------------------------------------------
const DEV_AGGREGATE_PATHS = ['/dev/analytics/aggregate', '/admin/dev/analytics/aggregate'];

export interface AggregateResult {
  days: string[];
  as_of: string;
}

let lastAggregateAt = 0;

/**
 * Runs `analytics:aggregate` synchronously for `{from, to}` (default: today, Dhaka). Retries once after a 429.
 * Two runs are kept > 1 s apart: the response cache key carries `computed_at` at whole-second precision (P82-19), so a
 * read cached right after one run would otherwise be served again after a second run in the same second (P82-QA-1).
 */
export async function aggregate(admin: AdminSession, body: { from?: string; to?: string } = {}): Promise<AggregateResult> {
  const wait = lastAggregateAt + 1_100 - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  try {
    return await aggregateOnce(admin, body);
  } finally {
    lastAggregateAt = Date.now();
  }
}

async function aggregateOnce(admin: AdminSession, body: { from?: string; to?: string }): Promise<AggregateResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const path of DEV_AGGREGATE_PATHS) {
      const r = await adminApi(admin, 'POST', path, body);
      if (r.status === 404 || r.status === 405) continue;
      if (r.status === 429 && attempt === 0) break;
      expect(r.status, `POST ${path}: ${r.text.slice(0, 400)}`).toBe(200);
      const data = r.json.data as AggregateResult;
      expect(Array.isArray(data.days), r.text).toBe(true);
      return data;
    }
    // 429 (10/min): wait for the window to pass, then try again once.
    await new Promise((res) => setTimeout(res, 61_000));
  }
  throw new Error(`dev aggregate endpoint not found (tried ${DEV_AGGREGATE_PATHS.join(', ')}): is APP_ENV local/testing?`);
}

// ---------------------------------------------------------------------------------------------
// Admin analytics API (§6.1, openapi 1.10.0)
// ---------------------------------------------------------------------------------------------
export type AnalyticsQuery = { range?: '30d' | 'quarter' | '12m' | 'custom'; from?: string; to?: string; granularity?: 'day' | 'week' | 'month' };

const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, v);
  return p.size ? `?${p}` : '';
};

async function ok(admin: AdminSession, path: string): Promise<{ data: Json; meta: Json }> {
  const r = await adminApi(admin, 'GET', path);
  expect(r.status, `GET ${path}: ${r.text.slice(0, 400)}`).toBe(200);
  expect(r.json.meta, `GET ${path} meta`).toBeTruthy();
  return { data: r.json.data as Json, meta: r.json.meta as Json };
}

export const overview = (admin: AdminSession, q: AnalyticsQuery = {}) => ok(admin, `/admin/analytics/overview${qs(q)}`);
export const revenue = (admin: AdminSession, q: AnalyticsQuery = {}) => ok(admin, `/admin/analytics/revenue${qs(q)}`);
export const tenantMetrics = (admin: AdminSession, tenantId: string) => ok(admin, `/admin/tenants/${tenantId}/metrics`);

/** `GET /admin/tenants` with a query string (e.g. `sort=-mrr&filter[q]=…`). */
export async function tenantsList(admin: AdminSession, query: string): Promise<{ data: Json[]; meta: Json }> {
  const r = await adminApi(admin, 'GET', `/admin/tenants?${query}`);
  expect(r.status, r.text.slice(0, 400)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}

/** One tenant's `AdminTenantSummary` from the list (search by slug/email). */
export async function tenantSummary(admin: AdminSession, q: string, tenantId: string): Promise<Json> {
  const { data } = await tenantsList(admin, `filter[q]=${encodeURIComponent(q)}`);
  const hit = data.find((t) => t.id === tenantId);
  expect(hit, `tenant ${tenantId} in /admin/tenants?filter[q]=${q}`).toBeTruthy();
  return hit!;
}

/** Order totals in paisa (merchant API), for the expected GMV of §3 / P82-11. The storefront checkout answers with
 * the order `number` (no merchant id), so each order is looked up by number first. */
export async function orderTotals(s: Session, orderNumbers: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const n of orderNumbers) out.push((await merchantOrder(s, await orderIdByNumber(s, n))).total_amount as number);
  return out;
}

/** P82-17 / §6.2 identities that must hold for every response (null-safe). */
export function expectMovementIdentity(m: Json, label: string): void {
  if (m.new_amount === null || m.opening_mrr_amount === null) return;
  expect(m.new_amount + m.expansion_amount - m.contraction_amount - m.churned_amount, `${label}: net = new + exp − contr − churn`).toBe(m.net_new_amount);
  expect(m.closing_mrr_amount - m.opening_mrr_amount, `${label}: net = closing − opening`).toBe(m.net_new_amount);
}

// ---------------------------------------------------------------------------------------------
// Platform staff for role checks (S83). Same pattern as phase8.admin-visual: a fixed-secret user per role, seeded with a
// test-only tinker write (APP_ENV local/testing only), sessions survive re-seeding (password_changed_at untouched).
// ---------------------------------------------------------------------------------------------
export interface StaffFixture {
  email: string;
  password: string;
  totpSecret: string;
  role: 'super_admin' | 'billing' | 'support' | 'read_only';
}

export const STAFF = {
  support: { email: 'e2e-support82@storeplix.com', password: 'password', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', role: 'support' },
  readOnly: { email: 'e2e-readonly82@storeplix.com', password: 'password', totpSecret: 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK', role: 'read_only' },
  visual: { email: 'e2e-visual@storeplix.com', password: 'password', totpSecret: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU', role: 'super_admin' },
} as const satisfies Record<string, StaffFixture>;

export function seedStaff(who: StaffFixture): void {
  if (!/^[a-z0-9.+-]+@storeplix\.com$/.test(who.email) || !/^[A-Z2-7]{32}$/.test(who.totpSecret)) throw new Error('bad staff fixture');
  tinker(`
    $u = App\\Domain\\Identity\\Models\\User::query()->firstOrNew(['email' => '${who.email}']);
    if (! $u->exists) { $u->fill(['name' => 'E2E ${who.role} staff', 'password' => '${who.password}', 'email_verified_at' => now(), 'password_changed_at' => now()]); }
    $u->forceFill(['platform_role' => '${who.role}', 'platform_disabled_at' => null, 'platform_locked_until' => null,
      'totp_secret' => '${who.totpSecret}', 'totp_confirmed_at' => $u->totp_confirmed_at ?? now(), 'totp_last_step' => null])->save();
    App\\Domain\\Admin\\Auth\\Models\\PlatformRecoveryCode::query()->where('user_id', $u->id)->delete();
    for ($i = 1; $i <= 10; $i++) { App\\Domain\\Admin\\Auth\\Models\\PlatformRecoveryCode::query()->create(['user_id' => $u->id, 'code_hash' => App\\Domain\\Admin\\Auth\\RecoveryCodes::hash(sprintf('staff82%03d', $i))]); }
    echo 'ok';
  `);
}

/**
 * Test-only: forget a tenant's "last active" (column + the 15-min throttle key, P82-16), so the next merchant request
 * must set it again. Writes the platform `tenants` table directly (no RLS on it).
 */
export function resetLastActive(tenantId: string): void {
  if (!/^[0-9a-z]{26}$/i.test(tenantId)) throw new Error('bad id');
  tinker(
    `Illuminate\\Support\\Facades\\DB::table('tenants')->where('id','${tenantId}')->update(['last_active_at'=>null]); Illuminate\\Support\\Facades\\Cache::forget('sp:tenant-active:${tenantId}'); echo 'ok';`,
  );
}

// ---------------------------------------------------------------------------------------------
// Formatting (mirrors packages/ui `formatBdt` / `formatCount`; apps import nothing from packages here, so it is copied)
// ---------------------------------------------------------------------------------------------
function groupIndian(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
}

/** "৳ 1,84,200" / "৳ 499" / "৳ 3,450.50" */
export function bdt(paisa: number): string {
  const frac = Math.abs(paisa) % 100;
  return `${paisa < 0 ? '−' : ''}৳ ${groupIndian(Math.trunc(Math.abs(paisa) / 100))}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

export const count = (n: number): string => `${n < 0 ? '−' : ''}${groupIndian(n)}`;

/** Mirror of `@storeplix/ui` `formatBdtCompact` (3 significant digits, K / L / Cr): "৳ 1.5 K", "৳ 18.4 L", "৳ 2.21 Cr". */
export function bdtCompact(paisa: number): string {
  const taka = Math.abs(paisa) / 100;
  const unit = ([[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']] as const).find(([size]) => taka >= size);
  let body: string;
  if (!unit) body = groupIndian(Math.round(taka));
  else {
    const n = taka / unit[0];
    const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    const raw = (Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits);
    body = `${n >= 1000 ? groupIndian(Math.round(n)) : raw.includes('.') ? raw.replace(/\.?0+$/, '') : raw} ${unit[1]}`;
  }
  return `${paisa < 0 ? '−' : ''}৳ ${body}`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A money value as the UI may print it: full lakh grouping ("৳ 1,84,200") or the compact K / L / Cr form ("৳ 1.5 K",
 * "৳ 18.4 L", "৳ 9.6 Cr", contract conventions; exact `formatBdtCompact` output included), with or without the space
 * after ৳ and before the unit.
 */
export function moneyPattern(paisa: number, opts: { symbol?: 'required' | 'optional' } = {}): RegExp {
  const taka = paisa / 100;
  const forms = new Set<string>([bdt(paisa).replace('৳ ', '')]);
  const compact = (unit: number, suffix: string) => {
    for (const v of [taka / unit, Math.floor((taka / unit) * 10) / 10]) {
      for (const d of [1, 2]) {
        const t = v.toFixed(d);
        forms.add(`${t} ${suffix}`).add(`${t}${suffix}`).add(`${t.replace(/\.0+$/, '')} ${suffix}`).add(`${t.replace(/\.0+$/, '')}${suffix}`);
      }
    }
  };
  if (taka >= 1e7) compact(1e7, 'Cr');
  if (taka >= 1e5) compact(1e5, 'L');
  if (taka >= 1e3) compact(1e3, 'K');
  forms.add(bdtCompact(paisa).replace('৳ ', ''));
  // A compact form ends in its unit letter, so the next text node may follow without a space ("৳ 15.1 K11 orders").
  const tail = `(?:(?<=[KLr])|(?![\\d,]))`;
  // Table columns headed "MRR ৳" / "GMV 30d ৳" print bare numbers (symbol optional; no digit right before the value).
  const head = opts.symbol === 'optional' ? `(?:৳\\s?|(?<![\\d,.]))` : `৳\\s?`;
  return new RegExp(`${head}(${[...forms].map(esc).join('|')})${tail}`);
}

// ---------------------------------------------------------------------------------------------
// UI selectors (super-admin SPA, contract §7.1). GUESS until the WEB build exists; one helper each.
// ---------------------------------------------------------------------------------------------
export async function openAdmin(page: Page, path: string): Promise<void> {
  await page.goto(`${adminUrl}${path}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
}

/** UI: no skeletons left (`role=status` "Loading …"), as in phase8.admin-visual. */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0, { timeout: 20_000 });
}

/** UI: caption under the page header "Data as of {d MMM} · updated {HH:mm}" (§7.1). */
export const dataAsOf = (page: Page): Locator => page.getByText(/Data as of /).first();

/** "22 Nov" for a `YYYY-MM-DD` date (the caption format `d MMM`). */
export function dayMonth(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

/** UI: range tabs (dashboard `15:263`, revenue `39:17083`): "30 days" / "Quarter" / "12 months" / "Custom". */
export function rangeTab(page: Page, label: '30 days' | 'Quarter' | '12 months' | 'Custom'): Locator {
  return page
    .getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('radio', { name: label, exact: true }))
    .or(page.getByRole('button', { name: label, exact: true }))
    .first();
}

/**
 * UI: a KPI tile / quick stat by its Figma label ("MRR", "Active shops", "Trial → paid", "Merchant GMV", "Revenue churn",
 * "ARR", "Net new MRR", "Churned MRR", "ARPA", "LTV", "Orders · 30d", "GMV · 30d"). Preferred markup:
 * a `<section aria-label="{label}">` (region) or `role="group"` named by the label (the WEB `KpiCard` does the former); fallback: the innermost ancestor of the exact label text that holds more
 * text than the label (works with the existing `KpiTile`/`StatTile`/`Stat`).
 */
export function kpi(scope: Page | Locator, label: string): Locator {
  const fallback = scope
    .getByText(label, { exact: true })
    .first()
    .locator(`xpath=ancestor::*[string-length(normalize-space(.)) > ${label.length + 1}][1]`);
  return scope
    .getByRole('region', { name: label, exact: true })
    .or(scope.getByRole('group', { name: label, exact: true }))
    .or(fallback)
    .first();
}

/** UI: a card by its heading ("Monthly recurring revenue by plan", "Plan mix", "MRR movement", "Cohort retention", …). */
export function card(page: Page, title: string | RegExp): Locator {
  const byHeading = page
    .getByRole('heading', { name: title })
    .first()
    .locator('xpath=ancestor::*[@role="region" or self::section or contains(concat(" ", @class, " "), " rounded-card ")][1]');
  return page.getByRole('region', { name: title }).or(byHeading).first();
}

/** UI: Revenue reports nav item (sidebar "Platform navigation", §7.1). */
export const revenueNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: 'Revenue reports' });

/** UI: "Compare to previous period" toggle `39:17092`. */
export function compareToggle(page: Page): Locator {
  const name = /compare/i;
  return page.getByRole('switch', { name }).or(page.getByRole('checkbox', { name })).or(page.getByRole('button', { name })).first();
}

/** UI: on/off state of a switch, checkbox or toggle button. */
export async function isOn(toggle: Locator): Promise<boolean> {
  const [checked, pressed] = await Promise.all([toggle.getAttribute('aria-checked'), toggle.getAttribute('aria-pressed')]);
  if (checked !== null) return checked === 'true';
  if (pressed !== null) return pressed === 'true';
  return toggle.isChecked();
}

/** UI: whether a tab/radio/toggle button is the selected one (`aria-selected` / `aria-checked` / `aria-pressed` / `data-state`). */
export async function isSelected(el: Locator): Promise<boolean> {
  for (const a of ['aria-selected', 'aria-checked', 'aria-pressed']) {
    const v = await el.getAttribute(a);
    if (v !== null) return v === 'true';
  }
  return /^(active|on|checked)$/.test((await el.getAttribute('data-state')) ?? '');
}

/** UI: Custom range form/popover (composed from the existing date filter): From / To dates, then Apply. */
export async function setCustomRange(page: Page, from: string, to: string): Promise<void> {
  await rangeTab(page, 'Custom').click();
  const form = page.getByRole('form', { name: /custom range/i }).or(page.getByRole('dialog')).last();
  const scope = (await form.count()) ? form : page;
  await scope.getByLabel(/^(From|Start)( date)?$/i).first().fill(from);
  await scope.getByLabel(/^(To|End)( date)?$/i).first().fill(to);
  await scope.getByRole('button', { name: /^(Apply|Done|Update|Show)$/i }).first().click();
}

/** UI: note shown when the range starts before `data_starts_on` ("History starts {date}"). */
export const historyStarts = (page: Page): Locator => page.getByText(/History starts/i).first();

/** UI: page-level / widget empty state ("No data yet — analytics are computed nightly"). */
export const noDataYet = (page: Page): Locator => page.getByText(/No data yet/i).first();

/** UI: Top paying merchants `39:18704`, the row of one shop. */
export const topMerchantRow = (page: Page, shopName: string): Locator => card(page, 'Top paying merchants').getByRole('row').filter({ hasText: shopName }).first();

/** UI: merchants list Sort select (8.1 `aria-label="Sort"`) — options "MRR · high to low", "GMV 30d · high to low", … */
export async function sortMerchants(page: Page, option: 'Newest' | 'MRR · high to low' | 'GMV 30d · high to low' | 'Orders 30d · high to low' | 'Last active · recent first'): Promise<void> {
  await page.getByLabel('Sort', { exact: true }).selectOption({ label: option });
}

/** UI: merchants table (8.1 `DataTable label="Merchants"`). */
export const merchantsTable = (page: Page): Locator => page.getByRole('table', { name: 'Merchants' });

/** UI: one cell of a merchants row by column header (`MRR`, `Orders 30d`, `GMV 30d`, `Last active`). */
export async function merchantCell(page: Page, shopName: string, header: RegExp): Promise<Locator> {
  const table = merchantsTable(page);
  const headers = await table.getByRole('columnheader').allTextContents();
  const idx = headers.findIndex((h) => header.test(h.trim()));
  expect(idx, `column ${header} in [${headers.join(' | ')}]`).toBeGreaterThanOrEqual(0);
  return table.getByRole('row').filter({ hasText: shopName }).first().getByRole('cell').nth(idx);
}

/** UI: merchant detail "GMV & platform revenue" card `33:5128`. */
export const gmvCard = (page: Page): Locator => card(page, /GMV & platform revenue/);

/** "Nov 2026" (`MMM yyyy`) for a `YYYY-MM-DD` date. */
export function monthYear(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
}
