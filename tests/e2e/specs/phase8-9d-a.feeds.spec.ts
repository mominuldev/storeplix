import { expect, test } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import { catalogItemCount, readyImage, disconnectRaw, feedItems, feedOverview, getIntegration, ipath, list, mUrl, syncRuns } from '../support/integrations';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-9D §16 QA part A (product feeds, FEEDS_FAKE=true + a `feeds` queue worker):
 *  Meta catalog: "Continue with Facebook" → fake OAuth (the authorize URL is the API callback with a canned code) →
 *  303 back to the dashboard with ?oauth=success → choose the catalog → first sync → items, one of them disapproved
 *  (the fake reports an issue for a title containing "issue") → status Needs attention (items_with_issues) on the
 *  detail page and the Integrations list → Products tab + Fix all drawer show the issue → Disconnect needs the typed
 *  DISCONNECT (wrong text 422 confirmation_mismatch) → not connected and the local items are deleted.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('p89dfd', 'starter', 8);
  const sid = shop.s.storeId;
  // Only active, published products with a price and a photo are sent (P89D-27): two photographed products.
  const img1 = await readyImage(shop.s, [180, 40, 60]);
  const img2 = await readyImage(shop.s, [40, 120, 60]);
  const ok = await api(shop.s, 'POST', `/stores/${sid}/products`, {
    name: 'QA Feed Cotton Panjabi',
    status: 'active',
    category_ids: [shop.category.id],
    images: [{ media_id: img2, alt: null }],
    variants: [{ sku: `QA-FEED-${Date.now().toString(36)}`.toUpperCase(), price_amount: 180000, initial_on_hand: 4 }],
  });
  expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  const issue = await api(shop.s, 'POST', `/stores/${sid}/products`, {
    name: 'QA Issue Jamdani Saree',
    status: 'active',
    category_ids: [shop.category.id],
    images: [{ media_id: img1, alt: null }],
    variants: [{ sku: `QA-ISSUE-${Date.now().toString(36)}`.toUpperCase(), price_amount: 250000, initial_on_hand: 4 }],
  });
  expect(issue.status, JSON.stringify(issue.json)).toBe(201);
  // a draft product never reaches the feed (S340)
  const draft = await api(shop.s, 'POST', `/stores/${sid}/products`, { name: 'QA Draft Panjabi', status: 'draft', variants: [{ sku: `QA-DRAFT-${Date.now().toString(36)}`.toUpperCase(), price_amount: 90000, initial_on_hand: 2 }] });
  expect(draft.status, JSON.stringify(draft.json)).toBe(201);
});
test.afterAll(() => shop?.cleanup());

test('Meta catalog: fake OAuth → choose catalog → items + an issue → Needs attention', async ({ page, context }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/meta-catalog'));
  const start = page.waitForResponse((r) => r.url().endsWith('/integrations/meta_catalog/oauth/start'));
  const callback = page.waitForResponse((r) => r.url().includes('/integrations/oauth/meta_catalog/callback'));
  // P89D-QA-A2 (fixed): on localhost the button follows the fake driver's http:// authorize URL (the API callback) itself;
  // the page navigates away, so the authorize URL is read from the callback request rather than the start body.
  await page.getByRole('button', { name: 'Continue with Facebook' }).click({ timeout: 20_000 });
  expect((await start).status()).toBe(200);
  // browser → API callback (signed single-use state) → 303 → dashboard ?oauth=success (the page then drops the param)
  const cb = await callback;
  const authorizeUrl = cb.url();
  expect(cb.status()).toBe(303);
  expect(cb.headers().location).toMatch(/^http:\/\/localhost:5183\/integrations\/meta[-_]catalog\?(.*&)?oauth=success/);
  await expect(page.getByText('Choose a catalog')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Finish setup').first()).toBeVisible();
  // the state is single-use: replaying the callback is refused and changes nothing
  const replay = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(replay.status).toBe(303);
  expect(replay.headers.get('location') ?? '').toMatch(/oauth=error/);
  expect((await getIntegration(shop.s, 'meta_catalog')).status).toBe('setup_required');

  await page.getByRole('radio', { name: /Storeplix test catalog/ }).click({ timeout: 20_000 });
  await expect(page.getByRole('radio', { name: /Create a new catalog/ })).toBeVisible();
  const chosen = page.waitForResponse((r) => r.url().endsWith('/integrations/meta_catalog/account') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Connect and start syncing' }).click();
  const ch = await chosen;
  expect(ch.status(), await ch.text()).toBe(200);
  expect(JSON.parse(ch.request().postData() ?? '{}')).toEqual({ account_id: '100200300' });

  // first full sync on the `feeds` queue
  await expect
    .poll(async () => (await syncRuns(shop.s, 'meta_catalog')).map((r) => r.status).join(','), { timeout: 90_000, message: 'first sync finished (worker on `feeds`?)' })
    .toMatch(/^(done|partial|succeeded|completed|partly_done)/);
  const runs = await syncRuns(shop.s, 'meta_catalog');
  expect(runs[0].trigger).toBe('connect');

  const items = await feedItems(shop.s, 'meta_catalog');
  const titles = items.data.map((i) => i.product?.name ?? i.title);
  test.info().annotations.push({ type: 'feed items', description: JSON.stringify(items.data.map((i) => [i.product?.name ?? i.title, i.review_status])) });
  expect(titles.some((t) => /Issue Jamdani/.test(String(t)))).toBe(true);
  const draftItem = items.data.find((i) => /Draft Panjabi/.test(String(i.product?.name ?? i.title)));
  expect(draftItem ? JSON.stringify(draftItem) : 'none', 'a draft product is never sent (S340)').toMatch(/^none$|"review_status":"not_sent"|"excluded"|"included":false/);
  const bad = items.data.find((i) => /Issue Jamdani/.test(String(i.product?.name ?? i.title)))!;
  expect(bad.review_status).toBe('disapproved');
  expect(bad.issues?.[0]?.message).toMatch(/Image too small/);
  const good = items.data.filter((i) => i.review_status === 'approved');
  expect(good.map((i) => String(i.product?.name ?? i.title)).some((t) => /Feed Cotton Panjabi/.test(t))).toBe(true);

  await expect
    .poll(async () => {
      const row = await getIntegration(shop.s, 'meta_catalog');
      return `${row.status}:${(row.attention ?? []).map((a: { reason: string }) => a.reason).join('|')}`;
    }, { timeout: 30_000 })
    .toMatch(/^needs_attention:.*items_with_issues/);
  const ov = await feedOverview(shop.s, 'meta_catalog');
  expect(JSON.stringify(ov)).toMatch(/issue/i);

  // detail page shows it
  await page.goto(mUrl('/integrations/meta-catalog'));
  await expect(page.getByRole('region', { name: 'Products in catalog' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Needs attention').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fix all' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(/Image too small|smaller than 500/).first()).toBeVisible({ timeout: 15_000 });
  await expect(drawer.getByText(/Issue Jamdani/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Products tab: the issue item is Disapproved
  await page.goto(mUrl('/integrations/meta-catalog?tab=products'));
  const row = page.getByRole('row').filter({ hasText: 'QA Issue Jamdani Saree' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText('Disapproved')).toBeVisible();

  // Integrations list: the card says Needs attention
  await page.goto(mUrl('/integrations'));
  const card = page.getByRole('article', { name: 'Facebook & Instagram catalog' });
  await expect(card.getByText('Needs attention')).toBeVisible({ timeout: 20_000 });
  const summary = (await list(shop.s)).find((r) => r.provider === 'meta_catalog')!;
  expect(summary.status).toBe('needs_attention');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('disconnect needs the typed DISCONNECT; afterwards the integration is off and local items are gone', async ({ page, context }) => {
  test.setTimeout(90_000);
  expect(catalogItemCount(shop.s.storeId)).toBeGreaterThan(0);
  const wrong = await disconnectRaw(shop.s, 'meta_catalog', 'disconnect');
  expect([wrong.status, wrong.json.error?.code], wrong.text).toEqual([422, 'confirmation_mismatch']);

  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/meta-catalog'));
  await page.getByRole('button', { name: 'Disconnect' }).click({ timeout: 20_000 });
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Disconnect' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type DISCONNECT to confirm').fill('disconnect');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type DISCONNECT to confirm').fill('DISCONNECT');
  const done = page.waitForResponse((r) => r.url().endsWith('/integrations/meta_catalog/disconnect'));
  await confirm.click();
  expect((await done).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Continue with Facebook' })).toBeVisible({ timeout: 20_000 });
  const row = await getIntegration(shop.s, 'meta_catalog');
  expect(row.status).toMatch(/^(not_connected|disconnected)$/);
  expect(catalogItemCount(shop.s.storeId)).toBe(0);
  // reads of a disconnected feed don't leak the old items
  const items = await api(shop.s, 'GET', ipath(shop.s, 'meta_catalog', '/items'));
  expect(items.status === 404 || items.status === 409 || (items.status === 200 && (items.json.data as unknown[]).length === 0), JSON.stringify(items.json)).toBe(true);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('P89D-QA-A2: "Continue with Facebook" follows the fake (http) authorize URL in local / CI', async ({ page, context }) => {
  test.setTimeout(60_000);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/meta-catalog'));
  await page.getByRole('button', { name: 'Continue with Facebook' }).click({ timeout: 20_000 });
  await expect(page).toHaveURL(/oauth=(success|error)/, { timeout: 15_000 });
});
