import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, unique, urls, waitForStorefront, type Session } from '../support/api';

/**
 * Phase 3 §10/§11.3: edit the hero in the V3 editor → the iframe preview updates; the public store is
 * unchanged until Publish; after Publish it shows the change in < 5 s (queue worker + revalidation).
 * Restores the demo theme's draft and published config afterwards.
 */
test.describe.configure({ mode: 'serial' });

const CODE = 'modern-commerce';
let s: Session;
let original: { draft: unknown; published: unknown } | null = null;

test.beforeAll(async () => {
  s = await demoSession();
  const t = await api(s, 'GET', `/stores/${s.storeId}/themes/${CODE}`);
  expect(t.status).toBe(200);
  original = { draft: t.json.data.draft_config, published: t.json.data.published_config };
});

test.afterAll(async () => {
  if (!original) return;
  const path = `/stores/${s.storeId}/themes/${CODE}`;
  // Publish the original published config, then put the original draft back on top of it.
  let t = await api(s, 'GET', path);
  let r = await api(s, 'PUT', `${path}/draft`, { config: original.published, base_revision: t.json.data.draft_revision });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  r = await api(s, 'POST', `${path}/publish`, { draft_revision: r.json.data.draft_revision });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  t = await api(s, 'GET', path);
  if (JSON.stringify(original.draft) !== JSON.stringify(original.published)) {
    r = await api(s, 'PUT', `${path}/draft`, { config: original.draft, base_revision: t.json.data.draft_revision });
    expect(r.status).toBe(200);
  }
});

test('edit hero → preview updates; publish → public storefront shows it', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const heading = unique('E2E hero ');

  await page.goto(`${urls.merchant}/online-store/editor?page=home`);
  const settings = page.getByRole('complementary', { name: 'Section settings' });
  await page.getByRole('complementary', { name: 'Sections' }).getByText('Hero', { exact: true }).click();
  const field = settings.getByRole('textbox', { name: /^Heading( \(required\))?$/ });
  await expect(field).toBeVisible({ timeout: 15_000 });

  const preview = page.frameLocator('iframe[title$="preview"]');
  await expect(preview.locator('[data-sp-section-id]').first()).toBeVisible({ timeout: 20_000 });

  const typedAt = Date.now();
  await field.fill(heading);
  // Contract P3-9: debounced draft save (600 ms) + postMessage refresh, target < 2 s. Allow 8 s in CI.
  await expect(preview.getByText(heading)).toBeVisible({ timeout: 8_000 });
  test.info().annotations.push({ type: 'preview-latency-ms', description: String(Date.now() - typedAt) });
  await expect(page.getByText(/Saved \d/)).toBeVisible();

  // Draft only: the public storefront must not show it.
  const pub = await fetch(`${urls.storefront}/`).then((r) => r.text());
  expect(pub).not.toContain(heading);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published. Your shop updates in a few seconds.')).toBeVisible({ timeout: 10_000 });
  const ms = await waitForStorefront('/', (html) => html.includes(heading), 5_000);
  test.info().annotations.push({ type: 'publish-latency-ms', description: String(ms) });
});
