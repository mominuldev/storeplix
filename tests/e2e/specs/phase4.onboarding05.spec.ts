import { expect, test } from '@playwright/test';
import { api, createTenant, signInDashboard, urls, type ThrowawayTenant } from '../support/api';
import { png, tagged } from '../support/catalog';

/**
 * Phase 4 §9.1 Onboarding 05 / §15.7, on a brand-new throwaway shop (so the checklist starts "not done"
 * and the demo catalog is untouched):
 *  - quick-add a product with sizes S and M (→ variable product, "Stock per size"), "+ Add another
 *    product" saves it (status active) and clears the form;
 *  - quick-add a second simple product, "Save & continue" → "/";
 *  - the dashboard checklist marks "Add products" done.
 * The throwaway tenant (and everything in it) is deleted afterwards.
 */
test.describe.configure({ mode: 'serial' });

let eve: ThrowawayTenant;

test.beforeAll(async () => {
  eve = await createTenant('ob5');
});

test.afterAll(async () => {
  eve?.cleanup();
});

test('quick-add 2 products → checklist "Add products" is done', async ({ page, context }) => {
  test.setTimeout(120_000);
  const s = eve.session;
  expect((await api(s, 'GET', `/stores/${s.storeId}/dashboard`)).json.data.setup.has_products).toBe(false);
  await signInDashboard(context, s);

  // Before: the checklist item is an open step that leads to step 05.
  await page.goto(`${urls.merchant}/`);
  await page.getByRole('button', { name: /Add products/ }).click();
  await page.waitForURL(/\/onboarding\/products$/);

  await expect(page.getByText(/Product 1 of 3/)).toBeVisible();
  await expect(page.getByText('Import from Facebook').first()).toBeVisible();
  await expect(page.getByText('Coming soon').first()).toBeVisible();

  const posts: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (/\/stores\/[^/]+\/products$/.test(r.url()) && r.method() === 'POST') posts.push(r.postDataJSON());
  });

  // Product 1: photo, sizes S + M, stock per size.
  const first = tagged('Onboard frock');
  await page.getByLabel('Product photos').setInputFiles({ name: 'e2e-ob5.png', mimeType: 'image/png', buffer: png(300, [90, 160, 90]) });
  await page.getByLabel(/^Product name/i).fill(first);
  await page.getByLabel('Description', { exact: true }).fill('Cotton frock.\n\nMachine wash.');
  await page.getByLabel(/^Price/i).first().fill('1,250');
  const sizes = page.getByRole('group', { name: 'Sizes' });
  await sizes.getByRole('button', { name: 'S', exact: true }).click();
  await sizes.getByRole('button', { name: 'M', exact: true }).click();
  await expect(page.getByLabel(/Stock per size/i)).toBeVisible();
  await page.getByLabel(/Stock per size/i).fill('4');
  await expect(page.getByRole('button', { name: 'Remove photo 1' })).toBeVisible({ timeout: 60_000 }); // photo uploaded + processed
  await page.getByRole('button', { name: /Add another product/ }).click();
  await expect(page.getByText('Saved 1 product')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Product 2 of 3/)).toBeVisible();
  await expect(page.getByLabel(/^Product name/i)).toHaveValue('');
  // The live phone preview lists it (desktop only).
  await expect(page.getByText(first).first()).toBeVisible();

  // Product 2: simple, Save & continue → "/".
  const second = tagged('Onboard scarf');
  await page.getByLabel(/^Product name/i).fill(second);
  await page.getByLabel(/^Price/i).first().fill('৪৫০'); // Bangla digits accepted
  await page.getByLabel('Stock', { exact: true }).fill('7');
  await page.getByRole('button', { name: /Save & continue/ }).click();
  // Phase 5a (§9): onboarding 05 now continues to 06 (delivery), not to the dashboard.
  await page.waitForURL((u) => u.pathname === '/onboarding/delivery', { timeout: 15_000 });

  expect(posts).toHaveLength(2);
  const list = await api(s, 'GET', `/stores/${s.storeId}/products?per_page=10`);
  const byName = Object.fromEntries((list.json.data as Array<{ name: string; id: string }>).map((p) => [p.name, p.id]));
  const frock = (await api(s, 'GET', `/stores/${s.storeId}/products/${byName[first]}`)).json.data;
  expect(frock).toMatchObject({ status: 'active', type: 'variable', options: [{ name: 'Size', values: ['S', 'M'] }] });
  expect(frock.images).toHaveLength(1);
  expect(frock.variants.map((v: { price_amount: number; inventory: { on_hand: number } }) => [v.price_amount, v.inventory.on_hand])).toEqual([
    [125000, 4],
    [125000, 4],
  ]);
  expect(frock.description?.content).toHaveLength(2); // two paragraphs
  const scarf = (await api(s, 'GET', `/stores/${s.storeId}/products/${byName[second]}`)).json.data;
  expect(scarf).toMatchObject({ status: 'active', type: 'simple' });
  expect(scarf.variants[0]).toMatchObject({ price_amount: 45000 });
  expect(scarf.variants[0].inventory.on_hand).toBe(7);

  // After: checklist done (no longer a link to step 05), and has_products true.
  expect((await api(s, 'GET', `/stores/${s.storeId}/dashboard`)).json.data.setup.has_products).toBe(true);
  await page.goto(`${urls.merchant}/`);
  await expect(page.getByText('Add products').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Add products/ })).toHaveCount(0); // done items are not actionable
});

test('Skip for now → "/" and Back → theme step', async ({ page, context }) => {
  await signInDashboard(context, eve.session);
  await page.goto(`${urls.merchant}/onboarding/products`);
  await page.getByRole('button', { name: 'Back' }).filter({ visible: true }).first().click();
  await page.waitForURL(/\/onboarding\/theme/);
  await page.goto(`${urls.merchant}/onboarding/products`);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.waitForURL((u) => u.pathname === '/');
});
