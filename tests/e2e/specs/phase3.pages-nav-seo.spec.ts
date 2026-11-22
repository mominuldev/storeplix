import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, unique, urls, waitForStorefront, type Session } from '../support/api';

/**
 * Phase 3 §10 flows on the demo store:
 *  - page create (New page dialog) → publish in the page editor → /pages/{slug} renders; drafts 404
 *  - navigation item → header link (and link removed again on restore)
 *  - "Hide the whole shop from Google" → robots.txt Disallow: / and noindex meta
 * Every spec restores what it changed (page deleted, menu/SEO put back).
 */
let s: Session;

type MenuItem = { id: string; label: string; link: unknown; children?: MenuItem[] };
const toInput = (items: MenuItem[]): MenuItem[] =>
  items.map(({ id, label, link, children }) => ({ id, label, link, ...(children?.length ? { children: toInput(children) } : {}) }));

async function snapshotMenus(): Promise<Record<string, MenuItem[]>> {
  const nav = await api(s, 'GET', `/stores/${s.storeId}/navigation`);
  return Object.fromEntries((nav.json.data as Array<{ handle: string; items: MenuItem[] }>).map((m) => [m.handle, toInput(m.items)]));
}

async function restoreMenus(before: Record<string, MenuItem[]>): Promise<void> {
  const nav = await api(s, 'GET', `/stores/${s.storeId}/navigation`);
  for (const m of nav.json.data as Array<{ handle: string; items: MenuItem[]; revision: number }>) {
    if (JSON.stringify(toInput(m.items)) === JSON.stringify(before[m.handle])) continue;
    const r = await api(s, 'PUT', `/stores/${s.storeId}/navigation/${m.handle}`, { revision: m.revision, items: before[m.handle] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
}

test.beforeAll(async () => {
  s = await demoSession();
});

test('page: create from the dialog, publish → /pages/{slug} renders; draft is 404 publicly', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const title = unique('E2E page ');
  const slug = title.toLowerCase().replace(/\s+/g, '-');
  let pageId: string | null = null;
  // The New page dialog's "Also add to Footer menu" is on by default and deleting a page leaves its menu
  // item behind (as page_missing, by contract), so snapshot the menus and put them back afterwards.
  const menusBefore = await snapshotMenus();
  try {
    await page.goto(`${urls.merchant}/online-store/pages`);
    const dialog = page.getByRole('dialog', { name: 'New page' });
    // A click that lands before the page list has hydrated is dropped on the slow local stack: retry once.
    await expect(async () => {
      if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'New page' }).first().click();
      await expect(dialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await dialog.getByRole('button', { name: /^Blank page/ }).click();
    await dialog.getByLabel('Page name').fill(title);
    await dialog.getByRole('button', { name: 'Create page' }).click();

    await page.waitForURL(/\/online-store\/pages\/[0-9a-z]{26}/);
    pageId = page.url().match(/pages\/([0-9a-z]{26})/)![1]!;
    const created = await api(s, 'GET', `/stores/${s.storeId}/pages/${pageId}`);
    expect(created.json.data).toMatchObject({ status: 'draft', slug });

    // Draft pages are not public.
    expect((await fetch(`${urls.storefront}/pages/${slug}`)).status).toBe(404);

    const settings = page.getByRole('complementary', { name: 'Page settings' });
    await settings.getByRole('tab', { name: 'Published' }).click();
    await expect
      .poll(async () => (await api(s, 'GET', `/stores/${s.storeId}/pages/${pageId}`)).json.data.status, { timeout: 10_000 })
      .toBe('published');

    await waitForStorefront(`/pages/${slug}`, (html) => html.includes(title), 8_000);
    const html = await fetch(`${urls.storefront}/pages/${slug}`).then((r) => r.text());
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toMatch(new RegExp(`<link rel="canonical" href="https?://demo\\.storeplix\\.test[^"]*/pages/${slug}"`));

    await page.goto(`${urls.storefront}/pages/${slug}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    // The sitemap lists published pages.
    const sitemap = await fetch(`${urls.storefront}/sitemap.xml`).then((r) => r.text());
    expect(sitemap).toContain(`/pages/${slug}</loc>`);
  } finally {
    if (pageId) expect((await api(s, 'DELETE', `/stores/${s.storeId}/pages/${pageId}`)).status).toBe(204);
    await restoreMenus(menusBefore);
  }
  await waitForStorefront(`/pages/${slug}`, (html) => !html.includes(title), 8_000);
});

test('navigation: a new main-menu item appears as a header link', async ({ page }) => {
  const nav = await api(s, 'GET', `/stores/${s.storeId}/navigation`);
  const main = nav.json.data.find((m: { handle: string }) => m.handle === 'main');
  const originalItems = toInput(main.items);
  const label = unique('E2E link ');
  const put = await api(s, 'PUT', `/stores/${s.storeId}/navigation/main`, {
    revision: main.revision,
    items: [...originalItems, { id: unique('e2e').slice(0, 14).replace(/[^a-z0-9]/g, 'x'), label, link: { type: 'url', url: 'https://example.com/e2e' } }],
  });
  expect(put.status, JSON.stringify(put.json)).toBe(200);
  try {
    await waitForStorefront('/', (html) => html.includes(label), 8_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${urls.storefront}/`);
    const link = page.getByRole('banner').getByRole('link', { name: label });
    await expect(link).toHaveAttribute('href', 'https://example.com/e2e');
    await expect(link).toHaveAttribute('rel', /noopener/);
  } finally {
    const restore = await api(s, 'PUT', `/stores/${s.storeId}/navigation/main`, { revision: put.json.data.revision, items: originalItems });
    expect(restore.status, JSON.stringify(restore.json)).toBe(200);
  }
  await waitForStorefront('/', (html) => !html.includes(label), 8_000);
});

test('SEO: "Hide the whole shop from Google" → robots Disallow: / and noindex meta', async ({ page, context }) => {
  test.setTimeout(60_000);
  await signInDashboard(context, s);
  const before = await api(s, 'GET', `/stores/${s.storeId}/settings`);
  expect(before.json.data.seo.hide_from_search).toBe(false);
  try {
    await page.goto(`${urls.merchant}/online-store/seo`);
    const toggle = page.getByRole('switch', { name: 'Hide the whole shop from Google' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api(s, 'GET', `/stores/${s.storeId}/settings`)).json.data.seo.hide_from_search).toBe(true);

    await waitForStorefront('/robots.txt', (t) => /Disallow: \/\s*$/m.test(t) && !t.includes('Sitemap:'), 8_000);
    const home = await fetch(`${urls.storefront}/`).then((r) => r.text());
    expect(home).toMatch(/<meta name="robots" content="noindex, nofollow/);
    const sitemap = await fetch(`${urls.storefront}/sitemap.xml`).then((r) => r.text());
    expect(sitemap).not.toContain('<loc>');
  } finally {
    const r = await api(s, 'PATCH', `/stores/${s.storeId}/settings`, { seo: { hide_from_search: false } });
    expect(r.status).toBe(200);
  }
  await waitForStorefront('/robots.txt', (t) => t.includes('Sitemap:'), 8_000);
});
