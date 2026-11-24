import { readFileSync } from 'node:fs';
import { expect, request, test } from '@playwright/test';
import { api, apiCall, demoSession, signInDashboard, urls, xsrfToken, type Session } from '../support/api';

/**
 * Phase 4 §7.4 / §15.10: cookie-based Sanctum auth (4.7a–c).
 *  - after login: no token in sessionStorage/localStorage, the session cookie is HttpOnly (not in
 *    document.cookie), SameSite=Lax, host-only;
 *  - a write without X-XSRF-TOKEN → 419 csrf_token_mismatch;
 *  - a request from a storefront-host origin is not stateful (401);
 *  - after logout, /auth/me → 401 and the SPA shows /login.
 * Uses one fresh login (throttle:auth) for the logout test so the cached demo session survives.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
test.beforeAll(async () => {
  s = await demoSession();
});

test('no token in JS storage; session cookie is HttpOnly, SameSite=Lax, host-only', async ({ page, context }) => {
  await signInDashboard(context, s);
  await page.goto(`${urls.merchant}/`);
  await expect(page).not.toHaveURL(/\/login/);
  const storage = await page.evaluate(() => ({
    session: Object.entries(sessionStorage),
    local: Object.entries(localStorage),
    cookie: document.cookie,
  }));
  for (const [k, v] of [...storage.session, ...storage.local]) {
    expect(k, 'no token key').not.toMatch(/token/i);
    expect(String(v), `${k} holds no bearer-looking value`).not.toMatch(/^\d+\|[A-Za-z0-9]{20,}$/);
  }
  const cookies = await context.cookies(urls.merchant);
  const sess = cookies.find((c) => /sp_session$/.test(c.name));
  expect(sess, `cookies: ${cookies.map((c) => c.name).join(', ')}`).toBeTruthy();
  expect(sess!).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(sess!.domain.startsWith('.'), 'host-only (no Domain attribute)').toBe(false);
  expect(storage.cookie).not.toContain(sess!.name);
  const xsrf = cookies.find((c) => c.name === 'XSRF-TOKEN');
  expect(xsrf?.httpOnly).toBe(false);
  expect(xsrf?.sameSite).toBe('Lax');
});

test('a write without X-XSRF-TOKEN → 419 csrf_token_mismatch; with it → OK', async () => {
  const r = await apiCall(s, 'PATCH', `/stores/${s.storeId}/settings`, { json: {}, omitCsrf: true });
  expect(r.status).toBe(419);
  expect(r.json.error.code).toBe('csrf_token_mismatch');
  const ok = await apiCall(s, 'PATCH', `/stores/${s.storeId}/settings`, { json: {} });
  expect([200, 422]).toContain(ok.status);
});

test('storefront-host origin is never stateful; bearer is gone after 4.7c', async () => {
  const state = JSON.parse(readFileSync(s.storageState!, 'utf8'));
  const ctx = await request.newContext({
    baseURL: urls.api,
    storageState: state,
    extraHTTPHeaders: { Accept: 'application/json', Origin: urls.storefront, Referer: `${urls.storefront}/`, 'X-Tenant-Id': s.tenantId },
  });
  // Cookies are host-only for localhost, so they would be sent to :8010 too; the origin decides.
  const me = await ctx.get('/api/v1/auth/me', { failOnStatusCode: false });
  expect(me.status()).toBe(401);
  await ctx.dispose();
  // 4.7c: non-stateful login → 400 stateful_required; a Bearer header authenticates nothing.
  const login = await api(null, 'POST', '/auth/login', { email: 'nobody@e2e.storeplix.test', password: 'whatever1' });
  expect(login.status).toBe(400);
  expect(login.json.error.code).toBe('stateful_required');
  const bearer = await fetch(`${urls.api}/api/v1/auth/me`, { headers: { Accept: 'application/json', Authorization: 'Bearer 1|abcdefghijklmnopqrstuvwxyz0123456789' } });
  expect(bearer.status).toBe(401);
});

test('logout invalidates the session: /auth/me → 401, SPA back on /login', async ({ page }) => {
  // Fresh login in its own context so the cached demo session is not logged out.
  const ctx = await request.newContext({ baseURL: urls.merchant, extraHTTPHeaders: { Accept: 'application/json', Referer: `${urls.merchant}/` } });
  await ctx.get('/sanctum/csrf-cookie');
  const login = await ctx.post('/api/v1/auth/login', { data: { email: process.env.DEMO_EMAIL ?? 'demo@storeplix.test', password: process.env.DEMO_PASSWORD ?? 'password' }, headers: { 'X-XSRF-TOKEN': (await xsrfToken(ctx)) ?? '' } });
  expect(login.status()).toBe(200);
  const body = await login.json();
  expect(body.data.token, '4.7c: no token in responses').toBeUndefined();
  const state = await ctx.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto(`${urls.merchant}/`);
  await expect(page).not.toHaveURL(/\/login/);

  const out = await ctx.post('/api/v1/auth/logout', { headers: { 'X-XSRF-TOKEN': (await xsrfToken(ctx)) ?? '' } });
  expect(out.status()).toBe(204);
  const me = await ctx.get('/api/v1/auth/me', { failOnStatusCode: false });
  expect(me.status()).toBe(401);
  await ctx.dispose();

  // The browser still has the old cookie: the next API call is 401 → /login with the notice.
  await page.reload();
  await page.waitForURL(/\/login/, { timeout: 15_000 });
});
