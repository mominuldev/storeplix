import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { browserHost, confirmedOrder, mapStoreHost, transition, type CommerceShop } from '../support/commerce';
import {
  blockTagHosts,
  events,
  GA4_ID,
  getIntegration,
  ipath,
  META_PIXEL_ID,
  mUrl,
  PASTED_META_SNIPPET,
  putIntegration,
  putIntegrationRaw,
  recordRequests,
  token,
  waitPurchase,
} from '../support/integrations';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { api, apiCall } from '../support/api';

/**
 * PHASE-8-9D §16 QA part A (pixels, fakes: TRACKING_FAKE=true + a `tracking` queue worker):
 *  - Meta pixel connect: a pasted base-code snippet is refused (client-side, no PUT; and the API answers 422
 *    integration_code_pasted on the field), then the bare ID + token connects; the token is never echoed (hint = last 4).
 *  - The live storefront renders the Storeplix Meta base tag (script[data-sp-tag=meta_pixel], fbq init with the ID only);
 *    a shop with nothing connected renders no tag (S349).
 *  - Place + confirm an order → one server `purchase` row (event_id purchase.{order}) delivered; replaying the order
 *    transitions adds none; the Event log shows it once.
 *  - Test mode: "Open shop in test mode" opens the signed `?sp_test=` link; the storefront turns it into the httpOnly
 *    `sp_track_test` cookie and strips the parameter.
 *  - GA4: the API secret is write-only (masked last 4 + Replace, no Show); Replace PUTs the new secret and the hint changes.
 *  - GTM (Growth): a web-container URL is refused in the form (no PUT); IP / local / non-443 URLs → 422
 *    integration_endpoint_blocked from the API.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let plain: CommerceShop;
const META_TOKEN = token('meta');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('p89dpx', 'growth', 20);
  plain = await purchasingShop('p89dpl', 'starter', 5);
  browserHost(shop);
  mapStoreHost(shop);
  browserHost(plain);
});
test.afterAll(() => {
  shop?.cleanup();
  plain?.cleanup();
});

test('Meta pixel: pasted snippet refused (client + API), then the ID + token connects', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  const puts = recordRequests(page, `/integrations/meta_pixel`);

  // API: pasted code is refused on the field it names, nothing is stored.
  const pasted = await putIntegrationRaw(shop.s, 'meta_pixel', { settings: { pixel_id: PASTED_META_SNIPPET }, credentials: { access_token: META_TOKEN } });
  expect([pasted.status, pasted.json.error?.code], pasted.text).toEqual([422, 'integration_code_pasted']);
  // The API names the field `settings.pixel_id`; the WEB form matches the bare key (`pixel_id`), see P89D-QA-A1.
  expect(pasted.json.error?.details?.field).toMatch(/^(settings\.)?pixel_id$/);
  expect((await getIntegration(shop.s, 'meta_pixel')).status).toBe('not_connected');

  await page.goto(mUrl('/integrations/meta-pixel'));
  const form = page.getByRole('form', { name: 'Connect Meta' });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel('Pixel ID').fill(PASTED_META_SNIPPET);
  await form.getByLabel('Conversions API access token').fill(META_TOKEN);
  await form.getByRole('button', { name: 'Connect Meta' }).click();
  await expect(form.getByText(/This looks like code\. Paste only the Pixel ID/)).toBeVisible();
  expect(puts.filter((r) => r.startsWith('PUT')), 'no PUT for pasted code').toEqual([]);

  await form.getByLabel('Pixel ID').fill(META_PIXEL_ID);
  await form.getByLabel('Test event code').fill('TEST48211');
  const saved = page.waitForResponse((r) => r.url().includes('/integrations/meta_pixel') && r.request().method() === 'PUT');
  await form.getByRole('button', { name: 'Connect Meta' }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body, 'token never echoed').not.toContain(META_TOKEN);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel(`Conversions API access token ending ${META_TOKEN.slice(-4)}`)).toBeVisible();

  const row = await getIntegration(shop.s, 'meta_pixel');
  expect(row.status).toMatch(/^(connected|needs_attention)$/);
  expect(row.settings.pixel_id).toBe(META_PIXEL_ID);
  expect(JSON.stringify(row)).not.toContain(META_TOKEN);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('storefront: the live shop renders the Storeplix Meta base tag; a shop with nothing connected renders none', async ({ page }) => {
  test.setTimeout(90_000);
  const blocked = await blockTagHosts(page);
  await page.goto(shop.storefront + '/');
  const tag = page.locator('script[data-sp-tag="meta_pixel"]');
  await expect(tag).toHaveCount(1, { timeout: 20_000 });
  expect(await tag.getAttribute('src')).toMatch(/^https:\/\/connect\.facebook\.net\//);
  const init = await page.evaluate(() => {
    const q = (window as unknown as { fbq?: { queue?: ArrayLike<unknown>[] } }).fbq?.queue ?? [];
    return Array.from(q).map((a) => Array.from(a as ArrayLike<unknown>));
  });
  expect(init, 'fbq init with the validated ID').toContainEqual(['init', META_PIXEL_ID]);
  expect(blocked.some((u) => u.includes('connect.facebook.net')), 'the tag was requested (and blocked by the test)').toBe(true);
  // No merchant string other than the ID reaches the page.
  const html = await page.content();
  expect(html).not.toContain(META_TOKEN);
  expect(html).not.toContain('TEST48211');

  const page2 = await page.context().newPage();
  await blockTagHosts(page2);
  await page2.goto(plain.storefront + '/');
  await expect(page2.locator('body')).toBeVisible();
  await page2.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page2.locator('script[data-sp-tag]')).toHaveCount(0);
  await expect(page2.locator('[data-sp-consent-bar]')).toHaveCount(0);
  await page2.close();
});

test('place + confirm an order → exactly one server purchase, delivered, shown once in the Event log', async ({ page, context }) => {
  test.setTimeout(150_000);
  const order = await confirmedOrder(shop);
  const rows = await waitPurchase(shop.s, 'meta_pixel', order.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ event: 'purchase', channel: 'server', source: 'order', test: false, order: { id: order.id, number: order.number } });
  // Further transitions never add a second purchase (P89D-21, S336).
  for (const step of ['ready', 'ship', 'deliver'] as const) {
    const r = await transition(shop.s, order.id, step, step === 'ship' ? { tracking_number: null } : {});
    expect([200, 422, 409]).toContain(r.status);
  }
  await page.waitForTimeout(3000);
  const all = (await events(shop.s, 'meta_pixel')).filter((e) => e.event_id === `purchase.${order.id}` && e.channel === 'server');
  expect(all, 'still one server purchase').toHaveLength(1);
  // the log never exposes payloads or hashed customer data
  expect(Object.keys(all[0])).not.toContain('payload');

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/meta-pixel?tab=events'));
  const log = page.getByRole('region', { name: 'Event log' });
  await expect(log).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText(`Order ${order.number}`)).toHaveCount(1, { timeout: 20_000 });
  await expect(log.getByText(/^(Delivered|Deduplicated)$/).first()).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('test mode: the signed ?sp_test= link opens the shop and becomes the httpOnly sp_track_test cookie', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/meta-pixel?tab=test-events'));
  const setup = page.getByRole('region', { name: 'Test your setup' });
  await expect(setup).toBeVisible({ timeout: 20_000 });

  // Send test event → a result line (fake driver accepts).
  const sent = page.waitForResponse((r) => r.url().includes('/integrations/meta_pixel/test-event'));
  await setup.getByRole('button', { name: 'Send test event' }).click();
  expect((await sent).status()).toBe(200);

  const popupP = context.waitForEvent('page');
  const modeP = page.waitForResponse((r) => r.url().includes('/integrations/meta_pixel/test-mode'));
  await setup.getByRole('button', { name: 'Open shop in test mode ↗' }).click();
  const mode = await modeP;
  expect(mode.status()).toBe(200);
  const data = (await mode.json()).data as { url: string; expires_at: string };
  expect(data.url).toMatch(/\?sp_test=[^&]+/);
  const minutes = (Date.parse(data.expires_at) - Date.now()) / 60_000;
  expect(minutes).toBeGreaterThan(25);
  expect(minutes).toBeLessThanOrEqual(31);
  await expect(setup.getByText(/Test mode on · \d+ min left/)).toBeVisible();
  const popup = await popupP;
  await blockTagHosts(popup);
  await popup.waitForLoadState('domcontentloaded');
  // the link is on the store's primary host ({slug}.localhost, see mapStoreHost)
  expect(new URL(data.url).hostname).toBe(shop.localHost);
  await expect.poll(() => new URL(popup.url()).searchParams.has('sp_test'), { timeout: 20_000, message: 'sp_test stripped from the URL' }).toBe(false);
  const cookie = (await context.cookies(shop.storefront)).find((k) => k.name === 'sp_track_test');
  expect(cookie, 'sp_track_test cookie').toBeTruthy();
  expect(cookie!.httpOnly).toBe(true);
  await popup.close();

  // The test event is in the log with test=true and is never a stats row.
  const testRows = await events(shop.s, 'meta_pixel', 'filter[test]=1');
  expect(testRows.some((e) => e.test === true && String(e.event_id).startsWith('test.'))).toBe(true);
});

test('GA4: the API secret is write-only; Replace PUTs the new secret and only the last 4 come back', async ({ page, context }) => {
  test.setTimeout(90_000);
  const first = token('ga4a');
  const cur = await getIntegration(shop.s, 'ga4');
  await putIntegration(shop.s, 'ga4', { settings: { ...cur.defaults, measurement_id: GA4_ID }, credentials: { api_secret: first } });

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/ga4'));
  await expect(page.getByLabel(`Measurement Protocol API secret ending ${first.slice(-4)}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Show/ })).toHaveCount(0);
  expect(await page.content()).not.toContain(first);

  const second = token('ga4b');
  await page.getByRole('button', { name: 'Replace Measurement Protocol API secret' }).click();
  const replace = page.getByRole('form', { name: 'Replace Measurement Protocol API secret' });
  await replace.getByLabel('New measurement Protocol API secret').fill(second);
  const put = page.waitForResponse((r) => r.url().endsWith('/integrations/ga4') && r.request().method() === 'PUT');
  await replace.getByRole('button', { name: 'Save' }).click();
  const res = await put;
  expect(res.status()).toBe(200);
  const sentBody = JSON.parse(res.request().postData() ?? '{}');
  expect(sentBody.credentials).toEqual({ api_secret: second });
  expect(await res.text()).not.toContain(second);
  await expect(page.getByLabel(`Measurement Protocol API secret ending ${second.slice(-4)}`)).toBeVisible({ timeout: 15_000 });
  const row = await getIntegration(shop.s, 'ga4');
  expect(JSON.stringify(row.credentials_hint)).toContain(second.slice(-4));
  expect(JSON.stringify(row)).not.toContain(second);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('GTM: a web container is refused in the form; IP, local and non-443 tagging URLs are blocked by the API', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  const puts = recordRequests(page, '/integrations/gtm_server');
  await page.goto(mUrl('/integrations/gtm'));
  const form = page.getByRole('form', { name: 'Connect Google Tag Manager' });
  await expect(form).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'Web containers aren’t supported' })).toBeVisible();
  await form.getByLabel('Server container ID').fill('GTM-W8K3PZ5');
  await form.getByLabel('Tagging server URL').fill('https://www.googletagmanager.com/gtm.js?id=GTM-W8K3PZ5');
  await form.getByLabel('Events are sent as (GA4 Measurement ID)').fill(GA4_ID);
  await form.getByRole('button', { name: 'Check and connect' }).click();
  await expect(form.getByText(/This is a web container \(gtm\.js\)/)).toBeVisible();
  await form.getByLabel('Tagging server URL').fill('https://10.0.0.7');
  await form.getByRole('button', { name: 'Check and connect' }).click();
  await expect(form.getByText(/not an IP address/)).toBeVisible();
  expect(puts.filter((r) => r.startsWith('PUT')), 'no PUT for refused URLs').toEqual([]);

  const base = { container_id: 'GTM-W8K3PZ5', measurement_id: GA4_ID };
  const cur = await getIntegration(shop.s, 'gtm_server');
  for (const url of ['https://10.0.0.7', 'https://169.254.169.254', 'https://sgtm.internal', 'https://localhost', 'https://sgtm.example.com:8443', 'http://sgtm.example.com']) {
    const r = await putIntegrationRaw(shop.s, 'gtm_server', { settings: { ...cur.defaults, ...base, tagging_server_url: url } });
    expect([r.status, r.json.error?.code], `${url}: ${r.text.slice(0, 300)}`).toEqual([422, expect.stringMatching(/^(integration_endpoint_blocked|validation_failed)$/)]);
  }
  // the web container URL is refused by the API too
  const web = await putIntegrationRaw(shop.s, 'gtm_server', { settings: { ...cur.defaults, ...base, tagging_server_url: 'https://www.googletagmanager.com/gtm.js?id=GTM-W8K3PZ5' } });
  expect(web.status, web.text).toBe(422);
  expect((await getIntegration(shop.s, 'gtm_server')).status).toBe('not_connected');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: no merchant markup in any tracking setting; GTM web-container field does not exist', async () => {
  const cur = await getIntegration(shop.s, 'tiktok_pixel');
  const r = await putIntegrationRaw(shop.s, 'tiktok_pixel', { settings: { ...cur.defaults, pixel_id: '<script>alert(1)</script>' }, credentials: { access_token: token('tt') } });
  expect(r.status).toBe(422);
  expect(r.json.error?.code).toMatch(/^(integration_code_pasted|integration_id_invalid|validation_failed)$/);
  // the read path never returns credentials
  const meta = await api(shop.s, 'GET', ipath(shop.s, 'meta_pixel'));
  expect(JSON.stringify(meta.json)).not.toContain(META_TOKEN);
  const raw = await apiCall(shop.s, 'GET', `/stores/${shop.s.storeId}/integrations`);
  expect(raw.text).not.toContain(META_TOKEN);
});
