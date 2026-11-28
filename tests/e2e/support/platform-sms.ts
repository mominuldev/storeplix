import { expect, type Locator, type Page } from '@playwright/test';
import { adminApi, adminUrl, type AdminSession } from './admin';
import { createTenant, tinker, type ThrowawayTenant } from './api';
import { setPlan } from './commerce';
import { sentSince, type SentSms } from './sms';

/**
 * Phase 8.9b helpers (PHASE-8-9B-CONTRACT §4–§12, §14 QA): the super-admin `/settings/sms` page (provider, message
 * types, broadcasts, log), the merchant Account "Store Plix SMS" card and the public `/s/{code}` opt-out page.
 *
 * The local stack runs with `SMS_DRIVER=log` (every SMS that is actually sent is a `sms.log_driver` line in laravel.log,
 * P89B-2: the env driver always wins for SENDING) and `SMS_PROVIDERS_HTTP_FAKE=true` (provider tests, rotation tests and
 * balance reads answer a canned success without network, §4.2). Real API, no mocks.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SMS_SETTINGS = '/settings/sms';
export type SmsSettingsTab = 'provider' | 'messages' | 'broadcasts' | 'log';

/** A BD test phone the staff member types for test sends (P89B-26). */
export const STAFF_TEST_PHONE = '01711555211';

// ----- Admin API (§9.1) -----
export const adminSms = (s: AdminSession, method: string, path: string, body?: unknown) => adminApi(s, method, `/admin/sms${path}`, body);

export async function adminOk(s: AdminSession, method: string, path: string, body: unknown, status: number, what: string): Promise<Json> {
  const r = await adminSms(s, method, path, body);
  expect(r.status, `${what}: ${r.text.slice(0, 600)}`).toBe(status);
  return r.json.data as Json;
}

export const providerOverview = (s: AdminSession) => adminOk(s, 'GET', '/providers', undefined, 200, 'provider overview');

/** REVE create body (§4.6). Promotional mask approved and `promotional` carried, so broadcasts can be scheduled. */
export function reveInput(name: string, o: Json = {}): Json {
  return {
    driver: 'revesms',
    name,
    credentials: { api_key: `qa-reve-key-${Date.now()}A1b2`, secret_key: `qa-reve-secret-${Date.now()}C3d4` },
    settings: { account_id: 'QA-7781', base_url: 'https://smpp.revesms.com:7790' },
    default_sender_id: 'Storeplix',
    promotional_sender_id: 'SPOffers',
    promotional_sender_status: 'approved',
    message_groups: ['shop', 'registration', 'billing', 'security', 'promotional'],
    ...o,
  };
}

/**
 * API path to a working database primary: create → test (canned) → activate with the typed name. Used by the specs
 * that need a configured gateway but don't test the configure drawer itself.
 */
export async function ensurePrimary(s: AdminSession, name = 'REVE SMS QA'): Promise<Json> {
  const o = await providerOverview(s);
  if (o.primary) return o.primary as Json;
  const p = await adminOk(s, 'POST', '/providers', reveInput(name), 201, 'create provider');
  const t = await adminOk(s, 'POST', `/providers/${p.id}/test`, { phone: STAFF_TEST_PHONE }, 200, 'test provider');
  expect(t.status, JSON.stringify(t)).toBe('passed');
  await adminOk(s, 'POST', `/providers/${p.id}/activate`, { role: 'primary', confirm_name: name }, 200, 'activate primary');
  return p;
}

// ----- Test-only DB resets (tinker; scratch / local DB only) -----

/**
 * Back to "no database provider" (source none with SMS_DRIVER=log): removes every provider row, the custom platform
 * templates, re-enables the editable message types, drops QA broadcasts, clears the routing cache, the limiters and the
 * admin-login throttle (Cache::flush). Test-only.
 */
export function resetPlatformSms(): void {
  tinker(
    [
      `$DB='Illuminate\\Support\\Facades\\DB';`,
      `$DB::table('sms_providers')->delete();`,
      `$DB::table('platform_sms_templates')->delete();`,
      `$DB::table('platform_sms_message_types')->update(['enabled'=>true]);`,
      `$DB::table('platform_sms_broadcasts')->where('name','like','QA %')->delete();`,
      `Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
    ].join(' '),
  );
}

/** Marks a user's phone verified (platform SMS only go to a verified phone, P89B-16) and clears any opt-out. */
export function verifyUserPhone(email: string): void {
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(email)) throw new Error('bad email');
  tinker(
    `Illuminate\\Support\\Facades\\DB::table('users')->where('email','${email}')->update(['phone_verified_at'=>now(),'platform_promo_sms_opted_out_at'=>null]); echo 'ok';`,
  );
}

/** Opted-out state of a user (`platform_promo_sms_opted_out_at` + source). */
export function optOutState(email: string): { at: string | null; source: string | null } {
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(email)) throw new Error('bad email');
  const out = tinker(
    `$u=Illuminate\\Support\\Facades\\DB::table('users')->where('email','${email}')->first(); echo 'OPT:'.json_encode(['at'=>$u->platform_promo_sms_opted_out_at,'source'=>$u->platform_promo_sms_opt_out_source ?? null]);`,
  );
  return JSON.parse(out.match(/OPT:(\{.*\})/)?.[1] ?? '{"at":null,"source":null}') as { at: string | null; source: string | null };
}

/** A throwaway merchant on `plan` whose owner phone is verified (a broadcast recipient). Always `cleanup()`. */
export async function verifiedMerchant(label: string, plan: 'free' | 'starter' | 'growth' = 'growth'): Promise<ThrowawayTenant> {
  const t = await createTenant(label);
  try {
    setPlan(t.session, plan);
    verifyUserPhone(t.email);
    return t;
  } catch (e) {
    t.cleanup();
    throw e;
  }
}

/** `019…` → `88019…` (the log driver's `to`). */
export const msisdn = (phone: string) => (phone.startsWith('880') ? phone : `88${phone.replace(/^\+?88/, '')}`);

/** The 8.9a mask `01711-•••211` for a local `01…` number. */
export const masked = (phone: string) => `${phone.slice(0, 5)}-•••${phone.slice(-3)}`;

/** The opt-out code from a broadcast SMS ("STOP: http://…/s/{code}"). */
export function optOutCode(text: string): string {
  const m = text.match(/\/s\/([A-Za-z0-9]{10})\b/);
  expect(m, `no opt-out link in "${text}"`).toBeTruthy();
  return m![1]!;
}

/** Waits for a `sms.log_driver` line after `mark` matching `pred` (the queue worker sends broadcasts). */
export async function waitSent(mark: number, pred: (m: SentSms) => boolean, what: string, timeout = 60_000): Promise<SentSms> {
  let hit: SentSms | undefined;
  await expect
    .poll(() => (hit = sentSince(mark).find(pred)) !== undefined, { timeout, intervals: [500, 1_000, 2_000], message: `${what} (queue worker on "notifications"? SMS_DRIVER=log?)` })
    .toBe(true);
  return hit!;
}

// ----- UI (§11) -----
export async function openSmsSettings(page: Page, tab: SmsSettingsTab = 'provider', extra = ''): Promise<void> {
  await page.goto(`${adminUrl}${SMS_SETTINGS}?tab=${tab}${extra}`);
  await expect(page.getByRole('tablist', { name: 'SMS provider sections' })).toBeVisible({ timeout: 20_000 });
}

export const section = (page: Page, title: string): Locator =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();

export const dialog = (page: Page, name: string | RegExp): Locator => page.getByRole('dialog', { name });
