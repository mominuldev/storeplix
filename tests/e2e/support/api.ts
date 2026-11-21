import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Shared helpers for the flow specs. They talk to the real running stack (see TESTING.md §2c).
 * Everything a spec changes is restored in `finally`/`afterAll`, so the specs are idempotent.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = resolve(here, '..');
export const API_DIR = process.env.API_DIR ?? resolve(E2E_ROOT, '../../apps/api');

export const urls = {
  api: process.env.API_URL ?? 'http://localhost:8000',
  merchant: process.env.MERCHANT_URL ?? 'http://localhost:5173',
  storefront: process.env.STOREFRONT_URL ?? 'http://demo.localhost:3000',
};

export const DEMO = {
  email: process.env.DEMO_EMAIL ?? 'demo@storeplix.test',
  password: process.env.DEMO_PASSWORD ?? 'password',
};

export interface Session {
  token: string;
  expires_at: string;
  tenantId: string;
  storeId: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function api(
  s: Pick<Session, 'token' | 'tenantId'> | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (s) {
    headers.Authorization = `Bearer ${s.token}`;
    headers['X-Tenant-Id'] = s.tenantId;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${urls.api}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const AUTH_FILE = resolve(E2E_ROOT, '.auth/demo.json');

/**
 * Demo owner session. Cached in tests/e2e/.auth (git-ignored) so a run costs one login: the API's
 * `throttle:auth` allows 10 auth calls per minute per IP, and the auth flow specs need some of those.
 */
export async function demoSession(): Promise<Session> {
  if (existsSync(AUTH_FILE)) {
    const cached = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Session;
    if (Date.parse(cached.expires_at) - Date.now() > 3_600_000) {
      const me = await api(cached, 'GET', '/auth/me');
      if (me.status === 200) return cached;
    }
  }
  const login = await api(null, 'POST', '/auth/login', DEMO);
  expect(login.status, JSON.stringify(login.json)).toBe(200);
  const { token, expires_at, user } = login.json.data;
  const tenantId = user.tenants[0].id as string;
  const stores = await api({ token, tenantId }, 'GET', '/stores');
  const s: Session = { token, expires_at, tenantId, storeId: stores.json.data[0].id };
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(s));
  return s;
}

/** Signs the merchant SPA in by seeding its session storage (same keys as packages/api-client session). */
export async function signInDashboard(context: BrowserContext, s: Session): Promise<void> {
  await context.addInitScript(
    ([origin, token, expiresAt, tenantId]) => {
      if (window.location.origin !== origin) return;
      window.sessionStorage.setItem('storeplix.merchant.token', token);
      window.sessionStorage.setItem('storeplix.merchant.expires_at', expiresAt);
      window.localStorage.setItem('storeplix.merchant.tenant', tenantId);
    },
    [new URL(urls.merchant).origin, s.token, s.expires_at, s.tenantId] as const,
  );
}

/** Polls the public storefront (no cookies) until `predicate(html)` holds. Returns the elapsed ms. */
export async function waitForStorefront(path: string, predicate: (body: string) => boolean, timeoutMs = 10_000): Promise<number> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${urls.storefront}${path}`, { redirect: 'manual' });
    last = await res.text();
    if (predicate(last)) return Date.now() - started;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`storefront ${path} did not match within ${timeoutMs} ms. Last body starts: ${last.slice(0, 200)}`);
}

export const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------------------------
// Local mail (MAIL_MAILER=log): Laravel writes each message to storage/logs/laravel.log. The specs
// remember the log size before triggering a mail and read only what was appended after it.
// With Mailpit (docker compose, MAIL_MAILER=smtp) set MAILPIT_URL=http://localhost:8025 instead.
// ---------------------------------------------------------------------------------------------
export const LARAVEL_LOG = process.env.LARAVEL_LOG ?? resolve(API_DIR, 'storage/logs/laravel.log');
const MAILPIT = process.env.MAILPIT_URL;

export function mailMark(): number {
  return existsSync(LARAVEL_LOG) ? statSync(LARAVEL_LOG).size : 0;
}

/** Finds the first link to `pathPrefix` (e.g. "/invite?token=") in a mail sent to `to` after `mark`. */
export async function findMailLink(to: string, pathPrefix: string, mark: number, timeoutMs = 30_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const link = MAILPIT ? await mailpitLink(to, pathPrefix) : logLink(to, pathPrefix, mark);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no mail to ${to} containing ${pathPrefix} within ${timeoutMs} ms (log: ${MAILPIT ?? LARAVEL_LOG})`);
}

function decodeQuotedPrintable(s: string): string {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function logLink(to: string, pathPrefix: string, mark: number): string | null {
  if (!existsSync(LARAVEL_LOG)) return null;
  const buf = readFileSync(LARAVEL_LOG);
  const tail = buf.subarray(Math.min(mark, buf.length)).toString('utf8');
  const re = new RegExp(`https?://[^"'\\s<>]*${pathPrefix.replace(/[?.]/g, '\\$&')}[^"'\\s<>]*`);
  // One log entry per mail; only look inside entries addressed to `to`. The log driver writes the body
  // as-is even though the header says quoted-printable, so try the raw text first: decoding it blindly
  // would turn e.g. "token=86a8…" into "token\x86a8…". Fall back to decoded text for real QP bodies.
  for (const entry of tail.split(/\n(?=\[\d{4}-\d{2}-\d{2} )/)) {
    if (!entry.includes(`To: ${to}`)) continue;
    const m = entry.match(re) ?? decodeQuotedPrintable(entry).match(re);
    if (m) return m[0].replace(/&amp;/g, '&');
  }
  return null;
}

async function mailpitLink(to: string, pathPrefix: string): Promise<string | null> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as Json;
  const id = list.messages?.[0]?.ID;
  if (!id) return null;
  const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as Json;
  const m = String(msg.HTML ?? msg.Text ?? '').match(new RegExp(`https?://[^"'\\s<>]*${pathPrefix.replace(/[?.]/g, '\\$&')}[^"'\\s<>]*`));
  return m ? m[0].replace(/&amp;/g, '&') : null;
}

/**
 * Deletes a throwaway user created by a spec (users have no delete endpoint). Local stacks only:
 * runs `php artisan tinker` in apps/api (or `docker compose exec api` when E2E_ARTISAN=docker).
 * Only addresses ending in @e2e.storeplix.test are accepted, so it can never touch real accounts.
 */
export function deleteE2eUser(email: string): void {
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(email)) throw new Error(`refusing to delete ${email}`);
  // test-only cleanup: invitations reference accepted_user_id without cascade, so remove them first.
  const code = [
    `$e='${email}';`,
    `Illuminate\\Support\\Facades\\DB::table('staff_invitations')->where('email',$e)->delete();`,
    `Illuminate\\Support\\Facades\\DB::table('password_reset_tokens')->where('email',$e)->delete();`,
    `$u=App\\Domain\\Identity\\Models\\User::where('email',$e)->first();`,
    `if($u){ $u->tokens()->delete(); $u->delete(); echo 'deleted'; }`,
  ].join(' ');
  const cmd = process.env.E2E_ARTISAN === 'docker'
    ? ['docker', ['compose', 'exec', '-T', 'api', 'php', 'artisan', 'tinker', `--execute=${code}`]]
    : ['php', ['artisan', 'tinker', `--execute=${code}`]];
  execFileSync(cmd[0] as string, cmd[1] as string[], { cwd: process.env.E2E_ARTISAN === 'docker' ? resolve(E2E_ROOT, '../..') : API_DIR, stdio: 'pipe' });
}

export async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}
