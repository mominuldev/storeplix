import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request as pwRequest, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

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

// ---------------------------------------------------------------------------------------------
// Auth: cookie-based Sanctum sessions only (PHASE-4-CONTRACT §7.4; Bearer was removed in 4.7c).
// A Session is a Playwright storage-state file. Every authenticated API call goes through the merchant
// origin (Vite proxy → Laravel), so it is stateful: session cookie + X-XSRF-TOKEN on writes.
// Logins are SPA-style: GET /sanctum/csrf-cookie → POST /api/v1/auth/login, then the state is saved.
// ---------------------------------------------------------------------------------------------
export interface Session {
  /** path of the Playwright storage-state file */
  storageState: string;
  expires_at: string;
  tenantId: string;
  storeId: string;
}

/** Anything api() can authenticate with. `null` = anonymous (direct to the API origin, never stateful). */
export type ApiAuth = (Pick<Session, 'storageState' | 'tenantId'> & Partial<Session>) | null;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ApiResult {
  status: number;
  json: Json;
  text: string;
  headers: Record<string, string>;
}

const parse = (text: string): Json => {
  try {
    return text ? (JSON.parse(text) as Json) : {};
  } catch {
    return { raw: text };
  }
};

const SPA_HEADERS = () => ({ Accept: 'application/json', Referer: `${urls.merchant}/` });
const cookieContexts = new Map<string, Promise<APIRequestContext>>();

/** One stateful request context per storage-state file, reused for the whole worker. */
function cookieContext(storageState: string): Promise<APIRequestContext> {
  let ctx = cookieContexts.get(storageState);
  if (!ctx) {
    ctx = pwRequest.newContext({ baseURL: urls.merchant, storageState, extraHTTPHeaders: SPA_HEADERS() });
    cookieContexts.set(storageState, ctx);
  }
  return ctx;
}

/** Fresh, cookie-less SPA-origin context (for logins, registration, invitation accept). */
export function spaContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: urls.merchant, extraHTTPHeaders: SPA_HEADERS() });
}

export async function xsrfToken(ctx: APIRequestContext): Promise<string | null> {
  const c = (await ctx.storageState()).cookies.find((k) => k.name === 'XSRF-TOKEN');
  return c ? decodeURIComponent(c.value) : null;
}

export interface CallOptions {
  /** JSON body */
  json?: unknown;
  /** multipart body (file uploads). Values: string or { name, mimeType, buffer }. */
  multipart?: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>;
  headers?: Record<string, string>;
  /** do not send X-XSRF-TOKEN (CSRF negative tests) */
  omitCsrf?: boolean;
}

/**
 * Generic API call (JSON, multipart, text/CSV responses). `path` is relative to /api/v1 unless it starts
 * with `/sanctum/`. Sessions go through the merchant origin; anonymous calls go to the API origin.
 * Note: Playwright's request client never sends Sec-Fetch-Site, so Laravel's same-origin CSRF shortcut
 * never applies here: every write needs the X-XSRF-TOKEN header, which this sends.
 */
export async function apiCall(s: ApiAuth, method: string, path: string, opts: CallOptions = {}): Promise<ApiResult> {
  const fullPath = path.startsWith('/sanctum/') ? path : `/api/v1${path}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  let ctx: APIRequestContext;
  let url: string;
  if (s) {
    if (s.tenantId) headers['X-Tenant-Id'] = s.tenantId;
    ctx = await cookieContext(s.storageState);
    url = fullPath;
    if (!/^(GET|HEAD|OPTIONS)$/i.test(method) && !opts.omitCsrf) {
      const t = await xsrfToken(ctx);
      if (t) headers['X-XSRF-TOKEN'] = t;
    }
  } else {
    ctx = await anonContext();
    url = `${urls.api}${fullPath}`;
  }
  const res = await ctx.fetch(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { data: opts.json } : {}),
    ...(opts.multipart ? { multipart: opts.multipart } : {}),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  const text = await res.text();
  return { status: res.status(), json: parse(text), text, headers: res.headers() };
}

let anon: Promise<APIRequestContext> | null = null;
function anonContext(): Promise<APIRequestContext> {
  anon ??= pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
  return anon;
}

/** JSON API call (Phase 2/3 signature). */
export async function api(s: ApiAuth, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await apiCall(s, method, path, body === undefined ? {} : { json: body });
  return { status: r.status, json: r.json };
}

export const DEMO_STATE_FILE = resolve(E2E_ROOT, '.auth/demo.json');
const DEMO_META_FILE = resolve(E2E_ROOT, '.auth/demo.meta.json');

/**
 * Demo owner session. One login per run at most (`throttle:auth` = 10/min/IP): reused while /auth/me says
 * the session has more than 1 h left.
 */
export async function demoSession(): Promise<Session> {
  if (existsSync(DEMO_STATE_FILE) && existsSync(DEMO_META_FILE)) {
    try {
      const state = JSON.parse(readFileSync(DEMO_STATE_FILE, 'utf8')) as { cookies?: unknown[] };
      const meta = JSON.parse(readFileSync(DEMO_META_FILE, 'utf8')) as Pick<Session, 'tenantId' | 'storeId'>;
      if (Array.isArray(state.cookies)) {
        const probe: Session = { storageState: DEMO_STATE_FILE, expires_at: '', ...meta };
        const me = await api(probe, 'GET', '/auth/me');
        const exp = me.json.meta?.session_expires_at as string | undefined;
        if (me.status === 200 && exp && Date.parse(exp) - Date.now() > 3_600_000) return { ...probe, expires_at: exp };
      }
    } catch {
      /* stale file: log in again */
    }
    cookieContexts.delete(DEMO_STATE_FILE);
  }
  return cookieLogin(DEMO.email, DEMO.password, DEMO_STATE_FILE, DEMO_META_FILE);
}

/** SPA-style login: csrf-cookie → POST /auth/login → save storage state (+ tenant/store meta). */
export async function cookieLogin(email: string, password: string, statePath: string, metaPath?: string): Promise<Session> {
  const ctx = await spaContext();
  try {
    const csrf = await ctx.get('/sanctum/csrf-cookie');
    expect(csrf.status(), 'GET /sanctum/csrf-cookie through the merchant origin').toBe(204);
    const login = await ctx.post('/api/v1/auth/login', {
      data: { email, password },
      headers: { 'X-XSRF-TOKEN': (await xsrfToken(ctx)) ?? '' },
      failOnStatusCode: false,
    });
    const body = parse(await login.text());
    expect(login.status(), JSON.stringify(body)).toBe(200);
    return await saveSession(ctx, body, statePath, undefined, metaPath);
  } finally {
    await ctx.dispose();
  }
}

/** Saves the context's cookies as a Session (tenant from the auth body unless given). */
async function saveSession(ctx: APIRequestContext, body: Json, statePath: string, tenantId?: string, metaPath?: string): Promise<Session> {
  const { user, expires_at } = body.data;
  const tid = tenantId ?? (user?.tenants?.[0]?.id as string);
  mkdirSync(dirname(statePath), { recursive: true });
  await ctx.storageState({ path: statePath });
  cookieContexts.delete(statePath);
  const partial = { storageState: statePath, expires_at, tenantId: tid };
  const stores = await api(partial, 'GET', '/stores');
  const s: Session = { ...partial, storeId: stores.json.data?.[0]?.id ?? '' };
  if (metaPath) writeFileSync(metaPath, JSON.stringify({ tenantId: s.tenantId, storeId: s.storeId }));
  return s;
}

/** POSTs an anonymous auth call the way the SPA does (csrf-cookie, same origin). Caller disposes ctx. */
async function spaAuthPost(path: string, body: unknown): Promise<{ status: number; json: Json; ctx: APIRequestContext }> {
  const ctx = await spaContext();
  await ctx.get('/sanctum/csrf-cookie');
  const res = await ctx.post(`/api/v1${path}`, { data: body, headers: { 'X-XSRF-TOKEN': (await xsrfToken(ctx)) ?? '' }, failOnStatusCode: false });
  return { status: res.status(), json: parse(await res.text()), ctx };
}

export interface ThrowawayMember {
  email: string;
  session: Session;
  /** removes the membership and deletes the user */
  cleanup: () => Promise<void>;
}

/**
 * Invites a throwaway user to the owner's shop with `role`, accepts through the mailed token (one
 * `throttle:auth` call) and returns their session. Always call `cleanup()` in afterAll.
 */
export async function createMember(owner: Session, role: 'staff' | 'admin'): Promise<ThrowawayMember> {
  const email = `${unique(role)}@e2e.storeplix.test`;
  const password = 'E2eMember12345';
  const cleanup = async () => {
    const staff = await api(owner, 'GET', '/staff');
    for (const m of (staff.json.data ?? []) as Array<{ id: string; email: string; kind: string }>) {
      if (m.email !== email) continue;
      await api(owner, 'DELETE', m.kind === 'invitation' ? `/staff/invitations/${m.id}` : `/staff/${m.id}`);
    }
    deleteE2eUser(email);
  };
  try {
    const mark = mailMark();
    const invite = await api(owner, 'POST', '/staff/invitations', { email, role, name: `E2E ${role}` });
    expect(invite.status, JSON.stringify(invite.json)).toBe(201);
    const link = await findMailLink(email, '/invite?token=', mark);
    const token = new URL(link).searchParams.get('token')!;
    const accepted = await spaAuthPost(`/invitations/${encodeURIComponent(token)}/accept`, {
      name: `E2E ${role}`,
      password,
      password_confirmation: password,
    });
    try {
      expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
      const s = await saveSession(accepted.ctx, accepted.json, resolve(E2E_ROOT, `.auth/${email.split('@')[0]}.json`), owner.tenantId);
      return { email, session: { ...s, storeId: owner.storeId }, cleanup };
    } finally {
      await accepted.ctx.dispose();
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export interface ThrowawayTenant {
  email: string;
  /** owner phone used at registration */
  phone: string;
  session: Session;
  slug: string;
  /** storefront host once `activateStorefront()` ran */
  host: string;
  /** makes the draft store public on `{slug}.localhost` (test-only DB write through artisan tinker) */
  activateStorefront: () => void;
  /** deletes the tenant (cascade) and its owner user */
  cleanup: () => void;
}

/**
 * Registers a second merchant (own tenant) with one store, for cross-tenant checks and the "new store
 * shows placeholders" storefront check. One `throttle:auth` call. Always call `cleanup()`.
 */
export async function createTenant(label = 'eve'): Promise<ThrowawayTenant> {
  const email = `${unique(`qa-${label}-`)}@e2e.storeplix.test`;
  const slug = unique(`qa-${label}-`).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const reg = await spaAuthPost('/auth/register', { name: `QA ${label}`, email, phone, password: 'E2eTenant12345', password_confirmation: 'E2eTenant12345' });
  let partial: Session;
  try {
    expect(reg.status, JSON.stringify(reg.json)).toBe(201);
    partial = await saveSession(reg.ctx, reg.json, resolve(E2E_ROOT, `.auth/${email.split('@')[0]}.json`));
  } finally {
    await reg.ctx.dispose();
  }
  const created = await api(partial, 'POST', '/stores', { name: `QA ${label} shop`, slug });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const session: Session = { ...partial, storeId: created.json.data.id };
  const host = `${slug}.localhost`;
  return {
    email,
    phone,
    session,
    slug,
    host,
    activateStorefront: () => {
      tinker(
        [
          `$sid='${session.storeId}'; $h='${host}';`,
          `$s=DB::table('stores')->where('id',$sid)->first();`,
          `DB::table('stores')->where('id',$sid)->update(['status'=>'active','updated_at'=>now()]);`,
          `if(!DB::table('store_domains')->where('hostname',$h)->exists()){ DB::table('store_domains')->insert(['id'=>(string) Illuminate\\Support\\Str::ulid(),'tenant_id'=>$s->tenant_id,'store_id'=>$sid,'hostname'=>$h,'type'=>'platform','status'=>'active','is_primary'=>false,'created_at'=>now(),'updated_at'=>now()]); }`,
          `Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
        ].join(' '),
      );
    },
    cleanup: () => deleteE2eTenant(session.tenantId, email),
  };
}

/** Signs the merchant SPA in: adds the session cookies and the non-secret session-store hints. */
export async function signInDashboard(context: BrowserContext, s: Session): Promise<void> {
  const state = JSON.parse(readFileSync(s.storageState, 'utf8')) as { cookies: Parameters<BrowserContext['addCookies']>[0] };
  await context.addCookies(state.cookies);
  await context.addInitScript(
    ([o, tenantId, expiresAt]) => {
      if (window.location.origin !== o) return;
      window.localStorage.setItem('storeplix.merchant.tenant', tenantId);
      if (!window.sessionStorage.getItem('storeplix.merchant.signed_in')) {
        window.sessionStorage.setItem('storeplix.merchant.signed_in', '1');
        if (expiresAt) window.sessionStorage.setItem('storeplix.merchant.expires_at', expiresAt);
      }
    },
    [new URL(urls.merchant).origin, s.tenantId, s.expires_at] as const,
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
 * Runs PHP in `php artisan tinker` (local apps/api, or `docker compose exec api` when E2E_ARTISAN=docker).
 * Test cleanup / fixture setup only; callers validate their inputs before interpolating them.
 *
 * Phase 5b-1: on Postgres the app connects as `storeplix_app` under RLS, and tinker has no tenant context, so
 * raw `DB::table()` reads would see nothing and writes would be refused. Test-only code therefore runs on the
 * `pgsql_admin` connection (BYPASSRLS, the platform path) whenever the default connection is pgsql. No-op on sqlite.
 */
const TINKER_PRELUDE =
  "if (config('database.default') === 'pgsql' && config('database.connections.pgsql_admin.username')) { Illuminate\\Support\\Facades\\DB::setDefaultConnection('pgsql_admin'); } ";

export function tinker(code: string): string {
  code = TINKER_PRELUDE + code;
  const docker = process.env.E2E_ARTISAN === 'docker';
  const [bin, args] = docker
    ? ['docker', ['compose', 'exec', '-T', 'api', 'php', 'artisan', 'tinker', `--execute=${code}`]]
    : ['php', ['artisan', 'tinker', `--execute=${code}`]];
  return execFileSync(bin, args, { cwd: docker ? resolve(E2E_ROOT, '../..') : API_DIR, stdio: 'pipe' }).toString();
}

const E2E_EMAIL = /^[a-z0-9.+-]+@e2e\.storeplix\.test$/;

/**
 * Deletes a throwaway user created by a spec (users have no delete endpoint). Local stacks only.
 * Only addresses ending in @e2e.storeplix.test are accepted, so it can never touch real accounts.
 */
export function deleteE2eUser(email: string): void {
  if (!E2E_EMAIL.test(email)) throw new Error(`refusing to delete ${email}`);
  // test-only cleanup: invitations reference accepted_user_id without cascade, so remove them first.
  tinker(
    [
      `$e='${email}';`,
      `Illuminate\\Support\\Facades\\DB::table('staff_invitations')->where('email',$e)->delete();`,
      `Illuminate\\Support\\Facades\\DB::table('password_reset_tokens')->where('email',$e)->delete();`,
      `$u=App\\Domain\\Identity\\Models\\User::where('email',$e)->first();`,
      `if($u){ if(Illuminate\\Support\\Facades\\Schema::hasTable('sessions')){ Illuminate\\Support\\Facades\\DB::table('sessions')->where('user_id',$u->id)->delete(); } if(method_exists($u,'tokens')){ $u->tokens()->delete(); } $u->delete(); echo 'deleted'; }`,
    ].join(' '),
  );
}

/**
 * Deletes a throwaway tenant (FK cascade removes its store, catalog, customers, imports, media rows) plus
 * its private/public files and its owner. Refuses unless the tenant's only owner is an @e2e address.
 */
export function deleteE2eTenant(tenantId: string, ownerEmail: string): void {
  if (!E2E_EMAIL.test(ownerEmail) || !/^[0-9a-z]{26}$/i.test(tenantId)) throw new Error(`refusing to delete tenant ${tenantId}`);
  tinker(
    [
      `$t='${tenantId}'; $e='${ownerEmail}'; $DB='Illuminate\\Support\\Facades\\DB';`,
      `$owners=$DB::table('tenant_users')->join('users','users.id','=','tenant_users.user_id')->where('tenant_users.tenant_id',$t)->where('tenant_users.role','owner')->pluck('users.email')->all();`,
      `if($owners!==[$e]){ echo 'refused'; } else {`,
      `foreach(['public','local'] as $d){ try { Illuminate\\Support\\Facades\\Storage::disk($d)->deleteDirectory('tenants/'.$t); } catch (Throwable $x) {} }`,
      `$DB::table('tenants')->where('id',$t)->delete(); echo 'tenant-deleted'; }`,
    ].join(' '),
  );
  deleteE2eUser(ownerEmail);
}

export async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}
