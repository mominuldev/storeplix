import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, type Locator, type Page } from '@playwright/test';
import { api, apiCall, urls, type ApiResult, type Session } from './api';
import { rawFetch } from './commerce';

/**
 * Phase 7 billing helpers (PHASE-7-CONTRACT §4.6, §6.1, §6.2, §7.2, §8.2). Fake platform gateway only
 * (`BILLING_FAKE=true`): no real bKash or SSLCommerz is ever called. Every route or selector guessed before the product
 * code existed lives in ONE helper below (marked "GUESS").
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type PlanCode = 'free' | 'starter' | 'growth';
export type Interval = 'month' | 'year';
export type BillingProvider = 'bkash' | 'sslcommerz';
/** Buttons of the fake hosted page (P7-20). */
export type BillingOutcome = 'pay' | 'wrong_amount' | 'fail' | 'cancel' | 'timeout';
export type ClockState = 'trial_ends_soon' | 'trial_ended' | 'renewal_due' | 'period_ended' | 'grace_ends_soon' | 'grace_ended' | 'domain_grace_ended';

/** Seeded monthly prices in paisa (PlanSeeder; yearly = 10 × monthly, P7-3). */
export const PRICE = { starter: { month: 49_900, year: 499_000 }, growth: { month: 149_900, year: 1_499_000 } } as const;

/** Testing-only clock (§4.6): moves the current tenant's subscription dates and runs ProcessSubscriptionJob inline. */
export async function clock(s: Session, state: ClockState): Promise<Json> {
  const r = await api(s, 'POST', '/dev/billing/clock', { state });
  expect(r.status, `dev clock ${state}: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json.data as Json;
}

export async function subscription(s: Session): Promise<Json> {
  const r = await api(s, 'GET', '/subscription');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

export async function features(s: Session): Promise<Json> {
  const r = await api(s, 'GET', '/features');
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

export const quote = (s: Session, plan_code: string, interval: Interval = 'month') => api(s, 'POST', '/billing/quote', { plan_code, interval });

export function changePlan(s: Session, plan_code: string, interval: Interval = 'month', key: string | null = randomUUID(), extra: Json = {}): Promise<ApiResult> {
  return apiCall(s, 'POST', '/billing/change-plan', { json: { plan_code, interval, ...extra }, headers: key ? { 'Idempotency-Key': key } : {} });
}

export function payInvoice(s: Session, invoiceId: string, provider: BillingProvider = 'bkash', key: string | null = randomUUID(), extra: Json = {}): Promise<ApiResult> {
  return apiCall(s, 'POST', `/billing/invoices/${invoiceId}/pay`, { json: { provider, ...extra }, headers: key ? { 'Idempotency-Key': key } : {} });
}

export async function invoices(s: Session, query = ''): Promise<{ data: Json[]; meta: Json }> {
  const r = await api(s, 'GET', `/billing/invoices${query ? `?${query}` : ''}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { data: r.json.data, meta: r.json.meta };
}

export async function invoice(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/billing/invoices/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

export async function billingPayment(s: Session, id: string): Promise<Json> {
  const r = await api(s, 'GET', `/billing/payments/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as Json;
}

/** Polls `GET /billing/payments/{id}` (which queries the provider itself once the last query is > 10 s old, §6.1). */
export async function waitBillingPayment(s: Session, id: string, status: string, timeout = 45_000): Promise<Json> {
  await expect.poll(async () => (await billingPayment(s, id)).status, { timeout, intervals: [1_000, 2_000, 3_000], message: `billing payment ${id} → ${status}` }).toBe(status);
  return billingPayment(s, id);
}

/** Binary GET through the merchant origin (cookie session): invoice PDFs. */
export async function binaryGet(s: Session, path: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  const ctx = await pwRequest.newContext({ baseURL: urls.merchant, storageState: s.storageState, extraHTTPHeaders: { Referer: `${urls.merchant}/` } });
  try {
    const res = await ctx.get(`/api/v1${path}`, { headers: { 'X-Tenant-Id': s.tenantId, Accept: 'application/pdf, application/json' }, failOnStatusCode: false, maxRedirects: 0 });
    return { status: res.status(), body: await res.body(), headers: res.headers() };
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Fake hosted page (P7-20, §7.2): GET /api/v1/dev/fake-billing-gateway/{payment} (signed) with buttons
// "Pay", "Pay wrong amount", "Fail", "Cancel", "Pay, then time out".
// ---------------------------------------------------------------------------------------------
const apiOrigin = () => new URL(urls.api).origin;
const onApi = (u: string) => {
  const x = new URL(u, urls.api);
  return `${apiOrigin()}${x.pathname}${x.search}`;
};
const isApiUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.origin === apiOrigin() || x.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
};

const OUTCOME_LABEL: Record<BillingOutcome, RegExp> = {
  pay: /^Pay$/i,
  wrong_amount: /wrong amount/i,
  fail: /^Fail/i,
  cancel: /^Cancel/i,
  timeout: /time ?out/i,
};

const decode = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

/**
 * GUESS (layout as the 5b fake page): one `<form method="post" action="…">` per outcome holding one submit button whose
 * text is the label (and `data-outcome` / `value`). Picks the form whose button label or value matches the outcome.
 */
function outcomeForm(html: string, outcome: BillingOutcome): { action: string; fields: Record<string, string> } {
  const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gi)];
  const want = OUTCOME_LABEL[outcome];
  const values: Record<BillingOutcome, string[]> = { pay: ['pay'], wrong_amount: ['wrong_amount', 'pay_wrong_amount', 'wrong-amount'], fail: ['fail'], cancel: ['cancel'], timeout: ['timeout', 'pay_timeout', 'pay_then_timeout', 'time_out'] };
  for (const [, action, inner] of forms) {
    const label = (inner.match(/<button[^>]*>([\s\S]*?)<\/button>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const value = inner.match(/<button[^>]*(?:value|data-outcome)="([^"]+)"/i)?.[1] ?? '';
    if (want.test(label) || values[outcome].includes(value)) {
      const fields = Object.fromEntries([...inner.matchAll(/<(?:input|button)[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)].map((m) => [m[1], decode(m[2])]));
      return { action: decode(action), fields };
    }
  }
  throw new Error(`fake billing page has no "${outcome}" form: ${html.slice(0, 600)}`);
}

/**
 * Server-side click on the fake page: outcome POST → signed API return → 303 to the merchant app. Returns every hop,
 * the signed return URL and the first URL outside the API (expected `{MERCHANT_APP_URL}/settings/plan?payment=…`).
 */
export async function fakeBillingOutcome(redirectUrl: string, outcome: BillingOutcome): Promise<{ hops: { url: string; status: number }[]; returnUrl: string | null; finalUrl: string }> {
  const pageUrl = onApi(redirectUrl);
  const page = await rawFetch(pageUrl, { headers: { Accept: 'text/html' } });
  expect(page.status, `fake billing page ${pageUrl}: ${page.text.slice(0, 300)}`).toBe(200);
  const form = outcomeForm(page.text, outcome);
  const hops: { url: string; status: number }[] = [];
  let url = onApi(new URL(form.action, pageUrl).toString());
  let res = await rawFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: new URLSearchParams(form.fields).toString() });
  hops.push({ url, status: res.status });
  let returnUrl: string | null = null;
  for (let i = 0; i < 5 && res.status >= 300 && res.status < 400 && res.headers.location; i++) {
    const next = new URL(res.headers.location, url).toString();
    if (!isApiUrl(next)) return { hops, returnUrl, finalUrl: next };
    if (/\/billing\/payments\/return\//.test(next)) returnUrl = onApi(next);
    url = onApi(next);
    res = await rawFetch(url, { headers: { Accept: 'text/html' } });
    hops.push({ url, status: res.status });
  }
  throw new Error(`fake billing ${outcome}: no redirect to the merchant app, hops ${JSON.stringify(hops)} body ${res.text.slice(0, 300)}`);
}

/** Only the outcome POST: the signed return URL WITHOUT calling it (forgery / replay checks). */
export async function fakeBillingReturnUrl(redirectUrl: string, outcome: BillingOutcome): Promise<string> {
  const pageUrl = onApi(redirectUrl);
  const page = await rawFetch(pageUrl, { headers: { Accept: 'text/html' } });
  expect(page.status).toBe(200);
  const form = outcomeForm(page.text, outcome);
  const action = onApi(new URL(form.action, pageUrl).toString());
  const res = await rawFetch(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields).toString() });
  expect(res.status, res.text.slice(0, 300)).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return onApi(new URL(res.headers.location, action).toString());
}

/**
 * API-level purchase: change-plan → pay → fake outcome. Returns the invoice, the payment and the redirect hops.
 * Use for setting a shop up on a real paid plan (no test-only DB write).
 */
export async function subscribe(s: Session, plan: Exclude<PlanCode, 'free'>, interval: Interval = 'month', provider: BillingProvider = 'bkash', outcome: BillingOutcome = 'pay') {
  const change = await changePlan(s, plan, interval);
  expect(change.status, change.text).toBe(201);
  const inv = change.json.data.invoice as Json;
  expect(inv.status).toBe('open');
  const pay = await payInvoice(s, inv.id, provider);
  expect(pay.status, pay.text).toBe(201);
  const result = await fakeBillingOutcome(pay.json.data.redirect_url, outcome);
  return { invoice: inv, payment: pay.json.data as Json, result };
}

// ---------------------------------------------------------------------------------------------
// Dashboard selectors (§8.2, §8.3). GUESS until the WEB build exists; one helper each.
// ---------------------------------------------------------------------------------------------
export async function openPlan(page: Page, query = ''): Promise<void> {
  await page.goto(`${urls.merchant}/settings/plan${query}`);
  await expect(page.getByRole('heading', { name: 'Plan & billing' }).first()).toBeVisible({ timeout: 20_000 });
}

/** Monthly / Yearly chips `65:17491` / `65:17493`. */
export async function chooseInterval(page: Page, interval: Interval): Promise<void> {
  const name = interval === 'month' ? /^Monthly/ : /^Yearly/;
  const chip = page.getByRole('radio', { name }).or(page.getByRole('tab', { name })).or(page.getByRole('button', { name })).first();
  await chip.click();
}

/** The plan card CTA: "Upgrade to X" / "Subscribe to X" / "Switch to X" (§8.2). */
export function planCta(page: Page, planName: 'Free' | 'Starter' | 'Growth'): Locator {
  const plans = page.locator('#plans');
  return plans.getByRole('button', { name: new RegExp(`^(Upgrade to|Subscribe to|Switch to|Downgrade to) ${planName}\\b`) }).first();
}

export const dialog = (page: Page): Locator => page.getByRole('dialog').last();

/** Confirms the change-plan dialog (the primary button, whatever the kind's label). */
export async function confirmChange(page: Page): Promise<void> {
  await dialog(page).getByRole('button', { name: /^(Continue|Confirm|Subscribe|Upgrade|Switch|Change plan|Continue to pay|Cancel plan|Downgrade)/ }).last().click();
}

/** Pay dialog: provider choice + Pay (§8.2). */
export async function payInDialog(page: Page, provider: BillingProvider): Promise<void> {
  const d = dialog(page);
  const label = provider === 'bkash' ? /bKash/ : /Card|SSLCommerz/;
  await d.getByRole('radio', { name: label }).or(d.getByRole('button', { name: label })).first().click();
  await d.getByRole('button', { name: /^Pay\b/ }).last().click();
}

/** The fake hosted page in the browser: one button per outcome. */
export async function clickFakeBilling(page: Page, outcome: BillingOutcome): Promise<void> {
  await expect(page).toHaveURL(/\/dev\/fake-billing-gateway\//, { timeout: 20_000 });
  await page.getByRole('button', { name: OUTCOME_LABEL[outcome] }).first().click();
}

/** "Pay now" on a banner or the past-due block. */
export const payNow = (page: Page): Locator => page.getByRole('button', { name: /^Pay now/ }).or(page.getByRole('link', { name: /^Pay now/ })).first();

/** Invoices table (`65:17622`): the row of an invoice number. */
export const invoiceRow = (page: Page, number: string): Locator => page.getByRole('row').filter({ hasText: number }).first();

// ---------------------------------------------------------------------------------------------
// Reports (§6.3, §6.4)
// ---------------------------------------------------------------------------------------------
export type ReportType = 'sales' | 'profit' | 'delivery';

export function report(s: Session, type: ReportType, from?: string, to?: string, as: Session = s): Promise<ApiResult> {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return apiCall(as, 'GET', `/stores/${s.storeId}/reports/${type}${q.size ? `?${q}` : ''}`);
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Adds days to a `YYYY-MM-DD` date (calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** UTC ISO instant of a local wall-clock time in a fixed-offset zone (Asia/Dhaka = +06:00, no DST). */
export function dhakaInstant(date: string, time: string): string {
  return new Date(`${date}T${time}:00+06:00`).toISOString();
}

export function openReports(page: Page, type: ReportType, query = ''): Promise<unknown> {
  return page.goto(`${urls.merchant}/reports/${type}${query}`);
}
