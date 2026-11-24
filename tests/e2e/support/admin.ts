import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, request as pwRequest, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { API_DIR, E2E_ROOT, tinker, xsrfToken } from './api';

/**
 * Phase 8.1 helpers (PHASE-8-1-CONTRACT §10 QA): super-admin sign-in with TOTP, admin API calls through the admin
 * SPA origin (Vite proxy → Laravel, stateful Sanctum session), and the e2e staff fixture
 * (`php artisan db:seed --class=PlatformStaffE2eSeeder`, see that seeder for the credentials).
 */
export const adminUrl = process.env.ADMIN_URL ?? 'http://localhost:5184';

export const SUPER_ADMIN = {
  email: 'e2e-superadmin@storeplix.com',
  password: 'password',
  totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  recoveryCodes: Array.from({ length: 10 }, (_, i) => `e2ecode${String(i + 1).padStart(3, '0')}`),
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238: SHA-1, 6 digits, 30 s), computed here so the spec needs no extra dependency.
// The API refuses a step that was already used (replay), so callers take a fresh step with `nextTotp()`.
// ---------------------------------------------------------------------------------------------
function base32(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

let lastStep = 0;
/** A code for a 30 s step this run has not used yet (waits for the next step when needed). */
export async function nextTotp(secret: string): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 250));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp(secret);
}

/**
 * Re-runs the staff seeder (clears a lock-out, restores the secret and the ten recovery codes) and resets the
 * `admin-login` throttle (5/email/IP per minute), which a spec file re-run within a minute would otherwise hit.
 */
export function reseedSuperAdmin(): void {
  tinker("Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';");
  const docker = process.env.E2E_ARTISAN === 'docker';
  const args = ['artisan', 'db:seed', '--class=PlatformStaffE2eSeeder', '--force'];
  if (docker) execFileSync('docker', ['compose', 'exec', '-T', 'api', 'php', ...args], { cwd: resolve(E2E_ROOT, '../..'), stdio: 'pipe' });
  else execFileSync('php', args, { cwd: API_DIR, stdio: 'pipe' });
  lastStep = 0;
}

// ---------------------------------------------------------------------------------------------
// Admin sessions: a Playwright storage-state file holding the admin-origin session cookie.
// ---------------------------------------------------------------------------------------------
export interface AdminSession {
  storageState: string;
  user: Json;
  session_expires_at: string;
}

const ADMIN_HEADERS = () => ({ Accept: 'application/json', Referer: `${adminUrl}/` });

export function adminContext(storageState?: string): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: adminUrl, extraHTTPHeaders: ADMIN_HEADERS(), ...(storageState ? { storageState } : {}) });
}

async function post(ctx: APIRequestContext, path: string, data: unknown) {
  const res = await ctx.post(`/api/v1${path}`, { data, headers: { 'X-XSRF-TOKEN': (await xsrfToken(ctx)) ?? '' }, failOnStatusCode: false });
  const text = await res.text();
  return { status: res.status(), json: (text ? JSON.parse(text) : {}) as Json };
}

/** Step 1 only: password → `{ step, login_token }` (or the 422). Caller disposes `ctx`. */
export async function adminPasswordStep(email: string, password: string) {
  const ctx = await adminContext();
  await ctx.get('/sanctum/csrf-cookie');
  return { ctx, ...(await post(ctx, '/admin/auth/login', { email, password })) };
}

export async function adminTotpStep(ctx: APIRequestContext, loginToken: string, body: { code?: string; recovery_code?: string }) {
  return post(ctx, '/admin/auth/totp', { login_token: loginToken, ...body });
}

/** Full sign-in (password + current TOTP) saved to `.auth/<name>.json`. */
export async function adminLogin(
  name = 'admin-super',
  who: { email: string; password: string; totpSecret: string } = SUPER_ADMIN,
): Promise<AdminSession> {
  const { ctx, status, json } = await adminPasswordStep(who.email, who.password);
  try {
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.data.step).toBe('totp');
    const done = await adminTotpStep(ctx, json.data.login_token, { code: await nextTotp(who.totpSecret) });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const storageState = resolve(E2E_ROOT, `.auth/${name}.json`);
    mkdirSync(dirname(storageState), { recursive: true });
    await ctx.storageState({ path: storageState });
    return { storageState, user: done.json.data.user, session_expires_at: done.json.data.session_expires_at };
  } finally {
    await ctx.dispose();
  }
}

const contexts = new Map<string, Promise<APIRequestContext>>();

/** Admin API call (path relative to /api/v1). Writes carry X-XSRF-TOKEN; `idempotent` adds an Idempotency-Key. */
export async function adminApi(
  s: AdminSession,
  method: string,
  path: string,
  body?: unknown,
  o: { idempotent?: boolean } = {},
): Promise<{ status: number; json: Json; text: string }> {
  let ctx = contexts.get(s.storageState);
  if (!ctx) {
    ctx = adminContext(s.storageState);
    contexts.set(s.storageState, ctx);
  }
  const c = await ctx;
  const headers: Record<string, string> = {};
  if (!/^(GET|HEAD)$/i.test(method)) headers['X-XSRF-TOKEN'] = (await xsrfToken(c)) ?? '';
  if (o.idempotent) headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await c.fetch(`/api/v1${path}`, { method, headers, ...(body !== undefined ? { data: body } : {}), failOnStatusCode: false, maxRedirects: 0 });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status(), json, text };
}

/** Puts the admin session cookies into a browser context, so the admin SPA opens signed in. */
export async function signInAdminApp(context: BrowserContext, s: AdminSession): Promise<void> {
  const state = JSON.parse(readFileSync(s.storageState, 'utf8')) as { cookies: Parameters<BrowserContext['addCookies']>[0] };
  await context.addCookies(state.cookies);
  await context.addInitScript(
    ([origin, expiresAt]) => {
      if (window.location.origin !== origin || window.sessionStorage.getItem('storeplix.admin.signed_in')) return;
      window.sessionStorage.setItem('storeplix.admin.signed_in', '1');
      window.sessionStorage.setItem('storeplix.admin.expires_at', expiresAt);
    },
    [new URL(adminUrl).origin, s.session_expires_at] as const,
  );
}

/** Finds a tenant through global search (`q` = shop name, slug, owner email/phone, domain or invoice number). */
export async function findTenant(s: AdminSession, q: string): Promise<Json> {
  const r = await adminApi(s, 'GET', `/admin/search?q=${encodeURIComponent(q)}`);
  expect(r.status, r.text).toBe(200);
  const tenants = (r.json.data?.tenants ?? []) as Json[];
  expect(tenants.length, `search "${q}": ${r.text}`).toBeGreaterThan(0);
  return tenants[0];
}

export const REASON = 'QA e2e ticket SP-8101';
