import { expect, test } from '@playwright/test';
import { api, createMember, createTenant, signInDashboard, urls, unique, type ThrowawayMember, type ThrowawayTenant } from '../support/api';
import { browserHost, setPlan, setupShop, sf, storefrontOrigin, type CommerceShop } from '../support/commerce';
import {
  ask,
  canonicalHref,
  cardAction,
  connectButton,
  devAge,
  devDns,
  devProvider,
  domainByHost,
  domainCard,
  getDomain,
  listDomains,
  noHorizontalOverflow,
  openDomains,
  statusBadge,
  storefrontGet,
  submitConnect,
  waitDomainStatus,
} from '../support/domains';

/**
 * PHASE-6-CONTRACT §10 QA (domains, domains-failures, domains-security, mobile) on the fake drivers (DOMAINS_FAKE=true).
 * A FRESH merchant + store (never the demo store: a custom primary would redirect every other spec). The custom host is
 * `shop-{random}.localhost` (P6-5: accepted only with DOMAINS_FAKE; Chromium and Node resolve `*.localhost`). The
 * platform host is checked twice: `{slug}.localhost` (browserHost, a platform row) and the real `{slug}.storeplix.test`
 * through a raw request with a Host header (no resolver rule needed).
 *
 * Flow: add in the UI → "Waiting for DNS" + TXT/CNAME → fake DNS correct → Check now → "Securing" → fake provider active →
 * Check now → "Connected" → Make primary (UI) → platform hosts 308 to the custom host (path + query kept), canonical on
 * the custom host, robots 301 → ask endpoint → taken/invalid/reserved → staff read-only → cross-tenant 404 → 390 px →
 * failures (mismatch, 72 h → Failed → re-check) → expiry → primary fallback → remove primary (UI) → platform serves 200.
 */
let shop: CommerceShop;
let eve: ThrowawayTenant | undefined;
let staff: ThrowawayMember | undefined;
let custom: string;
let second: string;
let domainId: string;
let platformHost: string; // `{slug}.localhost`, a platform row (browserHost)

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await setupShop('dom');
  // Both flush the API cache: run them before any fake DNS answer is written.
  setPlan(shop.s, 'starter'); // custom_domain feature, custom_domains limit 2 (Q70)
  browserHost(shop);
  platformHost = shop.localHost;
  const r = unique('').toLowerCase().replace(/[^a-z0-9]/g, '');
  custom = `shop-${r}.localhost`;
  second = `www-${r}.localhost`;
});

test.afterAll(async () => {
  await staff?.cleanup().catch(() => undefined);
  eve?.cleanup();
  shop?.cleanup();
});

test('add a custom domain in the UI → "Waiting for DNS" with the TXT and CNAME records', async ({ page, context }) => {
  test.setTimeout(120_000);
  const before = await listDomains(shop.s);
  expect(before.meta).toMatchObject({ txt_prefix: '_storeplix-verify', can_add: true, feature_enabled: true, limit: { used: 0, max: 2 } });
  expect(typeof before.meta.cname_target).toBe('string');
  const platform = before.data.filter((d) => d.type === 'platform');
  expect(platform.length).toBeGreaterThanOrEqual(1);
  expect(platform.every((d) => d.status === 'active' && d.dns_records.length === 0 && d.can_remove === false)).toBe(true);
  expect(before.data.filter((d) => d.is_primary)).toHaveLength(1);

  await signInDashboard(context, shop.s);
  await openDomains(page);
  // Client strips the scheme and trailing slash (§8).
  const dialog = await submitConnect(page, `https://${custom.toUpperCase()}/`);
  await expect(dialog).toBeHidden({ timeout: 20_000 }).catch(() => undefined);

  const d = await domainByHost(shop.s, custom);
  domainId = d.id;
  expect(d).toMatchObject({ type: 'custom', status: 'pending_verification', is_primary: false, routable: false, display_hostname: custom });
  expect(d.dns_records).toHaveLength(2);
  const txt = d.dns_records.find((x: { type: string }) => x.type === 'TXT');
  const cname = d.dns_records.find((x: { type: string }) => x.type === 'CNAME');
  expect(txt).toMatchObject({ purpose: 'ownership', name: `_storeplix-verify.${custom}` });
  expect(txt.value).toMatch(/^sp-verify=[a-z2-7]{52}$/);
  expect(cname).toMatchObject({ purpose: 'routing', name: custom, value: before.meta.cname_target });
  // S50/§6: nothing provider-side in the resource.
  expect(Object.keys(d)).not.toEqual(expect.arrayContaining(['provider_hostname_id']));
  expect(JSON.stringify(d)).not.toMatch(/provider_hostname_id|resolvers|verification_token/);

  await page.reload();
  await expect(statusBadge(page, custom, 'Waiting for DNS')).toBeVisible({ timeout: 20_000 });
  await cardAction(page, custom, 'View DNS records');
  await expect(page.getByText(txt.value).first()).toBeVisible();
  await expect(page.getByText(before.meta.cname_target as string).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('domains-dns-records.png'), fullPage: true });

  // S42: an unproven host never serves store data, and `ask` refuses it.
  expect((await sf(custom, 'GET', '/config')).status).toBe(404);
  expect((await ask(custom)).status).toBe(404);
});

test('fake DNS correct → Check now → "Securing" → fake provider active → Check now → "Connected"', async ({ page, context }) => {
  test.setTimeout(120_000);
  expect(domainId, 'add test must run first').toBeTruthy();
  await devDns(domainId, { ownership: 'correct', routing: 'correct' });

  await signInDashboard(context, shop.s);
  await openDomains(page);
  await cardAction(page, custom, 'Check now');
  await expect(statusBadge(page, custom, 'Securing')).toBeVisible({ timeout: 20_000 });
  let d = await getDomain(shop.s, domainId);
  expect(['verified', 'ssl_provisioning']).toContain(d.status);
  expect(d.dns_records.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok']);
  expect(d.verified_at).toBeTruthy();
  // ask allows verified / ssl_provisioning (a certificate may be issued once ownership is proven), storefront still 404.
  expect((await ask(custom)).status).toBe(200);
  expect((await sf(custom, 'GET', '/config')).status).toBe(404);

  await devProvider(domainId, { hostname_status: 'active', ssl_status: 'active' });
  await cardAction(page, custom, 'Check now');
  await expect(statusBadge(page, custom, 'Connected')).toBeVisible({ timeout: 20_000 });
  d = await getDomain(shop.s, domainId);
  expect(d).toMatchObject({ status: 'active', routable: true, ssl_status: 'active', can_make_primary: true });
  expect(d.activated_at).toBeTruthy();
  const a = await ask(custom);
  expect([a.status, a.json.data?.allowed]).toEqual([200, true]);
  expect(a.headers['cache-control'] ?? '').toContain('no-store');
  // Active but not primary (P6-15): a custom host always redirects to the primary, here the slug platform host.
  const cfg = await sf(custom, 'GET', '/config');
  expect(cfg.status).toBe(200);
  expect(cfg.json.data.store.redirect_host).toBe(shop.apiHost);
  // ...while platform hosts never redirect to a platform primary.
  expect((await sf(platformHost, 'GET', '/config')).json.data.store.redirect_host ?? null).toBeNull();
});

test('make primary in the UI → platform hosts 308 to the custom host (path + query kept), canonical + robots on it', async ({ page, context }) => {
  test.setTimeout(150_000);
  await signInDashboard(context, shop.s);
  await openDomains(page);
  await cardAction(page, custom, 'Make primary');
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText(/Visitors to every other address will be sent to/)).toBeVisible();
  await confirm.getByRole('button', { name: /^Make primary$/ }).click();
  await expect(confirm).toBeHidden({ timeout: 20_000 });
  await expect(domainCard(page, custom).getByText('Primary', { exact: true })).toBeVisible();

  const list = await listDomains(shop.s);
  expect(list.data.filter((d) => d.is_primary).map((d) => d.hostname)).toEqual([custom]);
  expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}`)).json.data.primary_domain).toBe(custom);

  // API decision (P6-15): redirect_host on platform hosts, null on the primary.
  for (const h of [shop.apiHost, platformHost]) {
    await expect.poll(async () => (await sf(h, 'GET', '/config')).json.data?.store?.redirect_host ?? null, { timeout: 15_000, message: `redirect_host on ${h}` }).toBe(custom);
  }
  const primaryCfg = await sf(custom, 'GET', '/config');
  expect([primaryCfg.status, primaryCfg.json.data.store.redirect_host ?? null, primaryCfg.json.data.store.primary_host]).toEqual([200, null, custom]);

  // Storefront (6.4): permanent redirect for pages, same path + query, within one revalidation cycle.
  const path = `/products/${shop.simple.slug}?ref=1&utm_source=qa`;
  const target = `${storefrontOrigin(custom)}${path}`;
  for (const h of [platformHost, shop.apiHost]) {
    await expect
      .poll(async () => {
        const r = await storefrontGet(h, path);
        return `${r.status} ${r.location}`;
      }, { timeout: 30_000, message: `${h}${path} → 308 ${target}` })
      .toBe(`308 ${target}`);
  }
  // HEAD redirects too; robots.txt / sitemap.xml are 301 to the same path on the primary.
  expect((await storefrontGet(platformHost, '/', 'HEAD')).status).toBe(308);
  const robots = await storefrontGet(platformHost, '/robots.txt');
  expect([robots.status, robots.location]).toEqual([301, `${storefrontOrigin(custom)}/robots.txt`]);
  const sitemap = await storefrontGet(shop.apiHost, '/sitemap.xml');
  expect([sitemap.status, sitemap.location]).toEqual([301, `${storefrontOrigin(custom)}/sitemap.xml`]);
  // S46: a forged X-Forwarded-Host / ?next= never changes the target.
  const forged = await storefrontGet(platformHost, `/?next=https://evil.example/`);
  const forgedUrl = new URL(forged.location ?? 'about:blank');
  expect([forged.status, forgedUrl.origin, forgedUrl.pathname, forgedUrl.searchParams.get('next')]).toEqual([308, storefrontOrigin(custom), '/', 'https://evil.example/']);

  // The custom primary serves the page with canonical on itself; robots/sitemap use it.
  const pdp = await storefrontGet(custom, `/products/${shop.simple.slug}`);
  expect(pdp.status).toBe(200);
  const canonical = canonicalHref(pdp.body);
  expect(canonical, 'canonical link on the custom primary').toBeTruthy();
  expect(new URL(canonical!).hostname).toBe(custom);
  const ownRobots = await storefrontGet(custom, '/robots.txt');
  expect(ownRobots.status).toBe(200);
  expect(ownRobots.body).toMatch(new RegExp(`Sitemap: https?://${custom.replace(/\./g, '\\.')}(:\\d+)?/sitemap\\.xml`));

  // In the browser: the platform address lands on the custom host.
  const nav = await page.goto(`${storefrontOrigin(platformHost)}/products/${shop.simple.slug}?ref=1`);
  expect(nav?.status()).toBe(200);
  expect(page.url()).toBe(`${storefrontOrigin(custom)}/products/${shop.simple.slug}?ref=1`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`^https?://${custom.replace(/\./g, '\\.')}(:\\d+)?/`));
});

test('ask endpoint: key required, identical 404s, 200 for the active host and the platform host', async () => {
  const noKey = await ask(custom, null);
  expect([noKey.status, noKey.json.error?.code]).toEqual([401, 'unauthenticated']);
  const wrong = await ask(custom, 'wrong-key');
  expect(wrong.status).toBe(401);
  expect((await ask(custom)).status).toBe(200);
  expect((await ask(shop.apiHost)).status).toBe(200);
  const unknown = await ask(`nobody-${unique('').toLowerCase()}.example.com`);
  const malformed = await ask('not a host/..');
  expect([unknown.status, unknown.json.error?.code]).toEqual([404, 'domain_not_allowed']);
  expect(malformed.status).toBe(404);
  expect(malformed.text).toBe(unknown.text);
});

test('taken, invalid and reserved hostnames: API codes and inline errors in the Connect dialog', async ({ page, context }) => {
  test.setTimeout(150_000);
  const add = (hostname: string) => api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname });
  const code = async (h: string) => {
    const r = await add(h);
    return `${r.status} ${r.json.error?.code}`;
  };
  expect(await code(custom)).toBe('422 domain_taken');
  expect(await code(custom.toUpperCase() + '.')).toBe('422 domain_taken'); // normalised: case + trailing dot
  // Kept short: the `domains` limiter is 30/min per tenant + user (POST/DELETE), the API suite has the full matrix.
  for (const h of ['127.0.0.1', '169.254.169.254', 'localhost', 'shop', 'shop.com:8080', 'co.uk', 'com.bd', 'metadata.google.internal']) {
    expect(await code(h), h).toBe('422 domain_invalid');
  }
  for (const h of ['x.storeplix.test', 'storeplix.com', (await listDomains(shop.s)).meta.cname_target as string]) {
    expect(await code(h), h).toBe('422 domain_reserved');
  }
  expect((await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, {})).json.error?.code).toBe('validation_failed');

  // Another tenant can't claim an active host (S40).
  eve = await createTenant('dom-eve');
  const eveAdd = await api(eve.session, 'POST', `/stores/${eve.session.storeId}/domains`, { hostname: custom });
  expect([eveAdd.status, eveAdd.json.error?.code]).toEqual([422, 'domain_taken']);

  await signInDashboard(context, shop.s);
  await openDomains(page);
  for (const [host, re] of [
    [custom, /already|taken|another/i],
    ['x.storeplix.test', /Storeplix|reserved|can't use|cannot use/i],
    ['127.0.0.1', /look like a domain|not a valid|valid domain/i],
  ] as const) {
    const dialog = await submitConnect(page, host);
    await expect(dialog.getByText(re).first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath(`connect-error-${host.replace(/[^a-z0-9]/gi, '_')}.png`) });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  }
});

test('S47 staff: records visible, no Connect / Check now / Make primary / Remove; writes 403', async ({ browser }) => {
  test.setTimeout(120_000);
  staff = await createMember(shop.s, 'staff');
  const ctx = await browser.newContext();
  try {
    await signInDashboard(ctx, staff.session);
    const page = await ctx.newPage();
    await openDomains(page);
    await expect(domainCard(page, custom)).toBeVisible();
    await expect(connectButton(page)).toHaveCount(0);
    for (const name of ['Check now', 'Make primary', 'Remove']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
    }
    const list = await listDomains(staff.session);
    expect(list.meta.can_add).toBe(false);
    expect(list.data.every((d) => !d.can_recheck && !d.can_make_primary && !d.can_remove)).toBe(true);
  } finally {
    await ctx.close();
  }
  const base = `/stores/${shop.s.storeId}/domains`;
  for (const [m, p, b] of [
    ['POST', base, { hostname: `staff-${unique('').toLowerCase()}.localhost` }],
    ['POST', `${base}/${domainId}/verify`, {}],
    ['POST', `${base}/${domainId}/primary`, {}],
    ['DELETE', `${base}/${domainId}`, undefined],
  ] as const) {
    const r = await api(staff.session, m, p, b);
    expect([`${m} ${p}`, r.status, r.json.error?.code]).toEqual([`${m} ${p}`, 403, 'forbidden']);
  }
});

test('S48 another tenant: every domain route on our id → 404 (API and dashboard detail)', async ({ page, context }) => {
  test.setTimeout(120_000);
  eve ??= await createTenant('dom-eve');
  const e = eve.session;
  const own = `/stores/${e.storeId}/domains/${domainId}`;
  const foreignStore = `/stores/${shop.s.storeId}/domains/${domainId}`;
  for (const [m, p] of [
    ['GET', own],
    ['POST', `${own}/verify`],
    ['POST', `${own}/primary`],
    ['DELETE', own],
    ['GET', foreignStore],
    ['GET', `/stores/${shop.s.storeId}/domains`],
  ] as const) {
    const r = await api(e, m, p, m === 'POST' ? {} : undefined);
    expect([`${m} ${p}`, r.status]).toEqual([`${m} ${p}`, 404]);
  }
  expect((await getDomain(shop.s, domainId)).status).toBe('active'); // untouched

  await signInDashboard(context, e);
  await page.goto(`${urls.merchant}/online-store/domains/${domainId}`);
  await expect(page.getByText(/not found|doesn't exist|does not exist|couldn't find/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(custom)).toHaveCount(0);
});

test('390 px: Domains page and the DNS records card have no horizontal overflow', async ({ browser }) => {
  test.setTimeout(120_000);
  // A second, still-pending domain so the records card has content.
  const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: second });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await signInDashboard(ctx, shop.s);
    const page = await ctx.newPage();
    await openDomains(page);
    await expect(domainCard(page, second)).toBeVisible();
    await noHorizontalOverflow(page, 'domains-list', (n) => test.info().outputPath(n));
    await cardAction(page, second, 'View DNS records');
    await expect(page.getByText(`_storeplix-verify`).first()).toBeVisible();
    await noHorizontalOverflow(page, 'domains-records', (n) => test.info().outputPath(n));
  } finally {
    await ctx.close();
  }
});

test('failures: wrong TXT → mismatch with what we found; 73 h → "Failed"; Check now → waiting again; 3rd domain → 402', async ({ page, context }) => {
  test.setTimeout(150_000);
  const d0 = await domainByHost(shop.s, second);
  let d = await devDns(d0.id, { ownership: 'wrong', routing: 'correct' }, true);
  expect(d.status).toBe('pending_verification');
  const txt = d.dns_records.find((x: { type: string }) => x.type === 'TXT');
  expect(txt.status).toBe('mismatch');
  expect(txt.found.length).toBeGreaterThan(0);
  expect(d.failure_code).toBe('txt_mismatch');
  expect(d.deadline_at).toBeTruthy();

  await signInDashboard(context, shop.s);
  await openDomains(page);
  await cardAction(page, second, 'View DNS records');
  await expect(page.getByText(/We found/i).first()).toBeVisible({ timeout: 15_000 });

  d = await devAge(d0.id, 73, true);
  expect(d.status).toBe('verification_failed');
  expect(['verification_timeout', 'txt_mismatch']).toContain(d.failure_code); // §2.1: timeout or the last record failure
  expect((await ask(second)).status).toBe(404);
  await openDomains(page);
  await expect(statusBadge(page, second, 'Failed')).toBeVisible({ timeout: 20_000 });
  await cardAction(page, second, 'Check now');
  await expect(statusBadge(page, second, 'Waiting for DNS')).toBeVisible({ timeout: 20_000 });
  d = await getDomain(shop.s, d0.id);
  expect(d.status).toBe('pending_verification');
  expect(Date.parse(d.deadline_at) - Date.now()).toBeGreaterThan(70 * 3_600_000); // fresh 72 h window

  // Plan limit (P6-7, Starter 2, every custom row counts in any status).
  const third = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: `third-${unique('').toLowerCase()}.localhost` });
  expect([third.status, third.json.error?.code]).toEqual([402, 'plan_limit_reached']);
  expect((await listDomains(shop.s)).meta).toMatchObject({ can_add: false, limit: { used: 2, max: 2 } });
  await page.reload();
  await expect(connectButton(page)).toBeDisabled();
  await expect(page.getByText(/allows 2 custom domains/i).first()).toBeVisible();

  // Pending rows can't be primary; platform rows are locked.
  const pr = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains/${d0.id}/primary`, {});
  expect([pr.status, pr.json.error?.code]).toEqual([409, 'domain_not_active']);
  const plat = (await listDomains(shop.s)).data.find((x) => x.type === 'platform')!;
  for (const [m, p] of [['DELETE', ''], ['POST', '/verify']] as const) {
    const r = await api(shop.s, m, `/stores/${shop.s.storeId}/domains/${plat.id}${p}`, m === 'POST' ? {} : undefined);
    expect([r.status, r.json.error?.code]).toEqual([409, 'platform_domain_locked']);
  }
  // Remove the pending one (no typed confirmation needed for a pending domain).
  expect((await api(shop.s, 'DELETE', `/stores/${shop.s.storeId}/domains/${d0.id}`)).status).toBe(204);
});

test('expiry: active primary with DNS missing for 7 days → "Disconnected", primary falls back, redirect stops', async ({ page, context }) => {
  test.setTimeout(150_000);
  let d = await devDns(domainId, { ownership: 'missing', routing: 'missing' }, true);
  expect(d.status).toBe('active'); // still routable inside the 7-day window
  expect(d.is_primary).toBe(true);
  d = await devAge(domainId, 7 * 24 + 1, true);
  expect([d.status, d.is_primary, d.routable]).toEqual(['expired', false, false]);
  const list = await listDomains(shop.s);
  const primary = list.data.find((x) => x.is_primary)!;
  expect([primary.type, primary.hostname]).toEqual(['platform', shop.apiHost]);

  await expect.poll(async () => (await storefrontGet(platformHost, '/')).status, { timeout: 30_000, message: 'platform host serves again' }).toBe(200);
  expect((await sf(custom, 'GET', '/config')).status).toBe(404);
  expect((await ask(custom)).status).toBe(404);

  await signInDashboard(context, shop.s);
  await openDomains(page);
  await expect(statusBadge(page, custom, 'Disconnected')).toBeVisible({ timeout: 20_000 });
});

test('remove the primary custom domain in the UI → platform primary, platform host serves 200', async ({ page, context }) => {
  test.setTimeout(180_000);
  // Back to active + primary: re-check from expired → pending → verified → provider → active.
  await devDns(domainId, { ownership: 'correct', routing: 'correct' });
  await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains/${domainId}/verify`, {});
  await devProvider(domainId, { hostname_status: 'active', ssl_status: 'active' }, true);
  await waitDomainStatus(shop.s, domainId, 'active');
  const mp = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains/${domainId}/primary`, {});
  expect(mp.status, JSON.stringify(mp.json)).toBe(200);
  await expect.poll(async () => (await storefrontGet(platformHost, '/')).status, { timeout: 30_000 }).toBe(308);

  await signInDashboard(context, shop.s);
  await openDomains(page);
  await cardAction(page, custom, 'Remove');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/will use .*again/i).first()).toBeVisible();
  const typed = dialog.getByRole('textbox');
  if (await typed.count()) await typed.first().fill(custom); // primary/active: type the hostname
  const clickRemove = () =>
    Promise.all([
      page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/domains/${domainId}`)),
      dialog.getByRole('button', { name: /^Remove( domain)?$/ }).click(),
    ]).then(([r]) => r);
  let del = await clickRemove();
  if (del.status() === 429) {
    // The spec makes ~30 domain writes in a minute (limiter `domains` 30/min per tenant + user): wait it out once.
    const wait = Number((await del.json()).error?.retry_after ?? 30);
    await expect(dialog, 'remove dialog stays open on 429').toBeVisible();
    await page.waitForTimeout((wait + 1) * 1000);
    del = await clickRemove();
  }
  expect(del.status(), await del.text()).toBe(204);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(domainCard(page, custom)).toHaveCount(0);

  const list = await listDomains(shop.s);
  expect(list.data.some((x) => x.hostname === custom)).toBe(false);
  expect(list.data.find((x) => x.is_primary)?.type).toBe('platform');
  await expect.poll(async () => (await storefrontGet(platformHost, `/products/${shop.simple.slug}?ref=1`)).status, { timeout: 30_000, message: 'platform host 200 after removal' }).toBe(200);
  expect((await sf(shop.apiHost, 'GET', '/config')).json.data.store.redirect_host ?? null).toBeNull();
  expect((await sf(custom, 'GET', '/config')).status).toBe(404);
  expect((await ask(custom)).status).toBe(404);
});
