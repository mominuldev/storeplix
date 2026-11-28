import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { adminApi, adminLogin, adminUrl, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { api, signInDashboard } from '../support/api';
import { type CommerceShop } from '../support/commerce';
import {
  aiCredits,
  aiLedger,
  describeRaw,
  generation,
  getIntegration,
  mUrl,
  productImages,
  readyImage,
  recordRequests,
  turnOnAi,
  waitGeneration,
} from '../support/integrations';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';

/**
 * PHASE-8-9D §16 QA part B — AI credits and tools (AI_DRIVER=fake, AI_IMAGE_DRIVER=fake, a worker on `ai`):
 *  - Claude: Turn on from /integrations/claude → product editor "Write with AI" → Write drafts (202 + Idempotency-Key)
 *    → the fake drafts → Insert below fills the description (unsaved, no product PATCH) → exactly 1 credit spent
 *    (summary + ledger `consume`). Also records whether the editor shows "Unsaved changes" right after loading.
 *  - AI photos: Edit with AI → Mint → Edit photo · 2 credits → before / after → Save to product (the product image is
 *    replaced in place) → Undo (the original is back) → 2 credits spent.
 *  - Exhausted: a Free shop (20 credits/month) spends all 20 → the editor shows the out-of-credits banner with Write
 *    drafts disabled; the API answers 402 ai_credits_exhausted {needed, available, resets_at}.
 *  - Super admin grants 100 bonus credits (Adjust AI credits dialog, reason) → the merchant sees them (API + Claude page)
 *    and the next draft is paid from the bonus.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let free: CommerceShop;
let photoProduct: { id: string; mediaId: string };
let admin: AdminSession;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-super-p89d');
  shop = await purchasingShop('p89dai', 'starter', 6);
  free = await purchasingShop('p89dfr', 'free', 6);
  const mediaId = await readyImage(shop.s, [210, 120, 40]);
  const p = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/products`, {
    name: 'QA AI Photo Kurti',
    status: 'active',
    images: [{ media_id: mediaId, alt: null }],
    variants: [{ sku: `QA-AIPH-${Date.now().toString(36)}`.toUpperCase(), price_amount: 120000, initial_on_hand: 3 }],
  });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  photoProduct = { id: p.json.data.id, mediaId };
});
test.afterAll(() => {
  shop?.cleanup();
  free?.cleanup();
});

test('Claude: Turn on → Write with AI → drafts → Insert below fills the editor (unsaved) and spends exactly 1 credit', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);

  // Off by default (P89D-2): the editor has no "Write with AI"
  await page.goto(mUrl(`/products/${shop.simple.id}`));
  await expect(page.getByLabel('Product name')).toHaveValue('QA Muslin Wrap', { timeout: 20_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByRole('button', { name: 'Write with AI' })).toHaveCount(0);
  // (The "Unsaved changes" on load question is answered by the P89D-QA-B1 test below.)

  await page.goto(mUrl('/integrations/claude'));
  await expect(page.getByRole('heading', { name: 'Claude by Anthropic' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('ai-credits-available')).toHaveText(/300/);
  const on = page.waitForResponse((r) => r.url().endsWith('/integrations/ai_writer') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Turn on' }).first().click();
  expect((await on).status()).toBe(200);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
  expect((await getIntegration(shop.s, 'ai_writer')).status).toBe('connected');

  const before = await aiCredits(shop.s);
  const writes = recordRequests(page, `/stores/${shop.s.storeId}/products/${shop.simple.id}`);
  await page.goto(mUrl(`/products/${shop.simple.id}`));
  await page.getByRole('button', { name: 'Write with AI' }).click({ timeout: 20_000 });
  const panel = page.getByRole('region', { name: 'Write with AI' });
  await panel.getByLabel('What should it mention? (optional)').fill('soft muslin, baby safe');
  await panel.getByRole('button', { name: 'Formal' }).click();
  const post = page.waitForResponse((r) => r.url().endsWith('/ai/product-descriptions') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Write drafts' }).click();
  const res = await post;
  expect(res.status()).toBe(202);
  expect(res.request().headers()['idempotency-key']).toBeTruthy();
  expect(JSON.parse(res.request().postData() ?? '{}')).toMatchObject({ product_id: shop.simple.id, key_points: ['soft muslin', 'baby safe'], tone: 'professional', variants: 2 });

  await expect(panel.getByText(/QA Muslin Wrap — আপনার প্রতিদিনের সঙ্গী।/).first()).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/Draft 1 of 2/)).toBeVisible();
  await expect(panel.getByTestId('ai-credits-line')).toContainText(`Used 1 credit · ${before.available - 1} left this month`);
  await panel.getByRole('button', { name: 'Insert below' }).click();
  await expect(page.getByText(/QA Muslin Wrap — আপনার প্রতিদিনের সঙ্গী।/).first()).toBeVisible();
  await expect(page.getByText('Unsaved changes').first()).toBeVisible();
  expect(writes.filter((w) => !w.startsWith('GET')), 'never auto-saved (P89D-52)').toEqual([]);

  const after = await aiCredits(shop.s);
  expect(after.available).toBe(before.available - 1);
  const consumes = (await aiLedger(shop.s)).filter((l) => l.type === 'consume');
  expect(consumes).toHaveLength(1);
  expect([consumes[0].credits, consumes[0].source]).toEqual([-1, 'allowance']);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('P89D-QA-B1: a saved product shows no "Unsaved changes" bar right after it loads', async ({ page, context }) => {
  test.setTimeout(90_000);
  // Answer for WEB (seen in jsdom): yes, in Chromium too — but only for a product whose description is empty (null).
  const withText = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/products`, {
    name: 'QA Described Shawl',
    status: 'active',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Soft wool shawl.' }] }] },
    variants: [{ sku: `QA-DESC-${Date.now().toString(36)}`.toUpperCase(), price_amount: 90000, initial_on_hand: 2 }],
  });
  expect(withText.status, JSON.stringify(withText.json)).toBe(201);
  await signInDashboard(context, shop.s);
  const counts: Record<string, number> = {};
  for (const [label, id] of [['with description', withText.json.data.id as string], ['empty description', shop.simple.id]] as const) {
    await page.goto(mUrl(`/products/${id}`));
    await expect(page.getByLabel('Product name')).not.toHaveValue('', { timeout: 20_000 });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1000);
    counts[label] = await page.getByText('Unsaved changes').count();
  }
  test.info().annotations.push({ type: 'unsaved-on-load', description: JSON.stringify(counts) });
  expect(counts['with description'], 'product with a description').toBe(0);
  expect(counts['empty description'], 'product with an empty description').toBe(0);
});

test('P89D-QA-B2: AI photos "Turn on" from /integrations/ai-photos', async ({ page, context }) => {
  test.setTimeout(60_000);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations/ai-photos'));
  await expect(page.getByRole('heading', { name: 'AI product photos' })).toBeVisible({ timeout: 20_000 });
  const put = page.waitForResponse((r) => r.url().endsWith('/integrations/ai_photos') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Turn on' }).first().click();
  const res = await put;
  test.info().annotations.push({ type: 'ai_photos turn on', description: `${res.status()} ${res.request().postData()} → ${(await res.text()).slice(0, 300)}` });
  expect(res.status()).toBe(200);
});

test('AI photos: Mint preset → before / after → Save to product (in place) → Undo restores the original; 2 credits', async ({ page, context }) => {
  test.setTimeout(150_000);
  await turnOnAi(shop.s, 'ai_photos');
  const before = await aiCredits(shop.s);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl(`/products/${photoProduct.id}`));
  await page.getByRole('button', { name: 'Edit with AI' }).first().click({ timeout: 20_000 });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Mint' }).click();
  const post = page.waitForResponse((r) => r.url().endsWith('/ai/photo-edits') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Edit photo · 2 credits' }).click();
  const res = await post;
  expect(res.status()).toBe(202);
  expect(JSON.parse(res.request().postData() ?? '{}')).toEqual({ media_id: photoProduct.mediaId, product_id: photoProduct.id, operation: 'replace_background', background: 'mint' });
  const genId = (await res.json()).data.id as string;

  await expect(dialog.getByRole('img', { name: 'Edited' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('img', { name: 'Original' })).toBeVisible();
  const done = await waitGeneration(shop.s, genId);
  expect(done.status).toBe('succeeded');
  expect((await aiCredits(shop.s)).available).toBe(before.available - 2);
  // unapplied result: the product is unchanged
  expect(await productImages(shop.s, photoProduct.id)).toEqual([photoProduct.mediaId]);

  const apply = page.waitForResponse((r) => r.url().endsWith(`/ai/photo-edits/${genId}/apply`));
  await dialog.getByRole('button', { name: 'Save to product' }).click();
  expect((await apply).status()).toBe(200);
  await expect.poll(() => productImages(shop.s, photoProduct.id)).not.toEqual([photoProduct.mediaId]);
  const applied = await productImages(shop.s, photoProduct.id);
  expect(applied, 'replaced in place, same count').toHaveLength(1);

  const undo = page.waitForResponse((r) => r.url().endsWith(`/ai/photo-edits/${genId}/undo`));
  await dialog.getByRole('button', { name: 'Undo' }).click();
  expect((await undo).status()).toBe(200);
  await expect.poll(() => productImages(shop.s, photoProduct.id)).toEqual([photoProduct.mediaId]);
  expect((await generation(shop.s, genId)).status).toBe('undone');
  // undo/apply never re-charge
  expect((await aiCredits(shop.s)).available).toBe(before.available - 2);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('exhausted: a Free shop spends its 20 credits → banner + Write drafts disabled; API 402 ai_credits_exhausted', async ({ page, context }) => {
  test.setTimeout(240_000);
  await turnOnAi(free.s, 'ai_writer');
  const start = await aiCredits(free.s);
  expect(start.allowance?.limit ?? start.limit).toBe(20);
  const ids: string[] = [];
  for (let i = 0; i < start.available; i++) {
    const r = await describeRaw(free.s, { name: `QA Exhaust Saree ${i}`, language: 'en', tone: 'friendly', length: 'short', variants: 1, key_points: [] });
    expect(r.status, r.text.slice(0, 300)).toBe(202);
    ids.push(r.json.data.id);
  }
  // idempotent replay never charges twice
  expect((await aiCredits(free.s)).available).toBe(0);
  for (const id of ids.slice(-2)) await waitGeneration(free.s, id);

  const c = watchConsole(page);
  await signInDashboard(context, free.s);
  await page.goto(mUrl(`/products/${free.simple.id}`));
  await page.getByRole('button', { name: 'Write with AI' }).click({ timeout: 20_000 });
  const panel = page.getByRole('region', { name: 'Write with AI' });
  await expect(panel.getByRole('alert')).toContainText(/have 0 left\. Your credits reset on/);
  await expect(panel.getByRole('button', { name: 'Write drafts' })).toBeDisabled();
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  let r = await describeRaw(free.s, { name: 'QA Exhaust one more', language: 'en', tone: 'friendly', length: 'short', variants: 1, key_points: [] });
  for (let i = 0; i < 8 && r.status === 429; i++) {
    await page.waitForTimeout(10_000); // ai-generate is 20/min per member
    r = await describeRaw(free.s, { name: 'QA Exhaust one more', language: 'en', tone: 'friendly', length: 'short', variants: 1, key_points: [] });
  }
  expect([r.status, r.json.error?.code], r.text).toEqual([402, 'ai_credits_exhausted']);
  expect(r.json.error.details).toMatchObject({ needed: 1, available: 0 });
  // resets at Dhaka midnight on the 1st (18:00Z the day before)
  const dhaka = new Date(Date.parse(r.json.error.details.resets_at) + 6 * 3600_000);
  expect([dhaka.getUTCDate(), dhaka.getUTCHours(), dhaka.getUTCMinutes()]).toEqual([1, 0, 0]);
});

test('super admin grants 100 bonus credits → the merchant sees them and the next draft is paid from the bonus', async ({ page, context }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await page.goto(`${adminUrl}/merchants/${free.s.tenantId}?tab=billing`);
  await expect(page.getByRole('heading', { name: 'AI credits' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Adjust AI credits' }).click();
  const dlg = page.getByRole('dialog', { name: 'Adjust AI credits' });
  await dlg.getByLabel('Credits to grant').fill('100');
  await expect(dlg.getByTestId('ai-adjust-delta')).toHaveText(/\+100/);
  await dlg.getByRole('radio', { name: /Promotion/ }).click();
  const adj = page.waitForResponse((r) => r.url().includes(`/admin/tenants/${free.s.tenantId}/ai-credits/adjust`));
  await dlg.getByRole('button', { name: 'Apply' }).click();
  const adjRes = await adj;
  expect(adjRes.status(), await adjRes.text()).toBeLessThan(300);
  await expect(dlg).toBeHidden({ timeout: 15_000 });
  const adminView = await adminApi(admin, 'GET', `/admin/tenants/${free.s.tenantId}/ai-credits`);
  expect(adminView.json.data?.credits?.bonus).toBe(100);
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  const merchant = await aiCredits(free.s);
  expect([merchant.bonus, merchant.available]).toEqual([100, 100]);
  const grant = (await aiLedger(free.s)).find((l) => l.credits === 100);
  expect(grant, 'merchant ledger shows the grant').toBeTruthy();

  const page2 = await context.browser()!.newContext().then((ctx) => ctx.newPage());
  await signInDashboard(page2.context(), free.s);
  await page2.goto(mUrl('/integrations/claude'));
  await expect(page2.getByTestId('ai-credits-available')).toHaveText(/100/, { timeout: 20_000 });

  let r = await describeRaw(free.s, { name: 'QA Bonus Saree', language: 'en', tone: 'friendly', length: 'short', variants: 1, key_points: [] }, randomUUID());
  for (let i = 0; i < 8 && r.status === 429; i++) {
    await page.waitForTimeout(10_000);
    r = await describeRaw(free.s, { name: 'QA Bonus Saree', language: 'en', tone: 'friendly', length: 'short', variants: 1, key_points: [] }, randomUUID());
  }
  expect(r.status, r.text).toBe(202);
  const after = await aiCredits(free.s);
  expect([after.bonus, after.available]).toEqual([99, 99]);
  const last = (await aiLedger(free.s)).find((l) => l.type === 'consume');
  expect(last?.source).toBe('bonus');
  await page2.context().close();
});
