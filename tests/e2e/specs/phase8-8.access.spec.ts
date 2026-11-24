import { expect, test } from '@playwright/test';
import { apiCall, createMember, signInDashboard, type ThrowawayMember } from '../support/api';
import { merchantOrder, orderIdByNumber, randomPhone, type CommerceShop } from '../support/commerce';
import {
  blockNumber,
  blockRaw,
  checkNumberRaw,
  codCheckout,
  fpath,
  GUARD,
  guardSettings,
  guardShop,
  managedRoutes,
  manualOrder,
  mUrl,
  openGuard,
  patchGuardRaw,
  planNote,
  protectionTag,
  releaseRaw,
  ruleSwitch,
  RULE_TITLES,
  waitGuard,
} from '../support/fraud-guard';
import { createRole, myMembership, navLabels, noAccess, watchConsole } from '../support/roles';

/**
 * PHASE-8-8 §13 QA access + plan (P88-14, P88-15, §2, §10; S155, S162, S166):
 *  - staff (no `fraud.manage`) → 403 on every §8.1 guard route, no "Fake order guard" nav item, no-access state on
 *    `/orders/fraud-guard`; owner has the key;
 *  - a custom role with `orders.view` + `fraud.manage` → reads/writes the settings, checks a number, sees the nav item
 *    and opens the page; it can't release a hold (`orders.process`) → 403;
 *  - owner UI: a rule toggle autosaves (PATCH) and "Reset to recommended" restores the defaults;
 *  - Free shop: reads 200, writes and "check a number" 402 `feature_not_in_plan`, a new number's COD order needs no OTP
 *    and is never held (no checks with actions), the guard page shows the plan note (Q198).
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let staff: ThrowawayMember | undefined;
let guardian: ThrowawayMember | undefined;
let entryId = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await guardShop('fgx', 'growth');
  entryId = (await blockNumber(shop.s, randomPhone(), 'QA access fixture')).id as string;
  staff = await createMember(shop.s, 'staff');
  const role = await createRole(shop.s, 'QA Guard keeper', ['orders.view', 'fraud.manage']);
  guardian = await createMember(shop.s, { role_id: role.id as string });
});
test.afterAll(async () => {
  await staff?.cleanup();
  await guardian?.cleanup();
  shop?.cleanup();
});

test('staff: 403 on every §8.1 guard route; owner holds fraud.manage, staff does not (S155)', async () => {
  expect((await myMembership(shop.s)).permissions ?? []).toContain('fraud.manage');
  expect((await myMembership(staff!.session)).permissions ?? []).not.toContain('fraud.manage');
  for (const [method, path, json] of managedRoutes(shop.s, entryId)) {
    const r = await apiCall(staff!.session, method, path, json === undefined ? {} : { json });
    expect([r.status, r.json.error?.code], `${method} ${path}`).toEqual([403, 'forbidden']);
  }
  // nothing changed by the refused writes
  expect((await guardSettings(shop.s)).daily_limit).toBe(3);
});

test('UI staff: no "Fake order guard" nav item; the page shows the no-access state', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, staff!.session);
  await page.goto(mUrl('/orders'));
  await expect(page.getByRole('heading', { name: /^Orders$/, level: 1 })).toBeVisible({ timeout: 20_000 });
  expect(await navLabels(page)).not.toContain('Fake order guard');
  await page.goto(mUrl(GUARD));
  await expect(noAccess(page)).toBeVisible({ timeout: 15_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('custom role with fraud.manage: settings, check a number; release still needs orders.process (P88-14, S162)', async () => {
  const g = { ...guardian!.session, storeId: shop.s.storeId };
  expect((await myMembership(g)).permissions).toContain('fraud.manage');
  const read = await apiCall(g, 'GET', fpath(shop.s, '/settings'));
  expect(read.status, read.text.slice(0, 200)).toBe(200);
  const patch = await patchGuardRaw(shop.s, { daily_limit: 4 }, g);
  expect(patch.status, patch.text.slice(0, 200)).toBe(200);
  expect(patch.json.data.daily_limit).toBe(4);
  const bad = await patchGuardRaw(shop.s, { hold_below: 80, advance_below: 70 }, g);
  expect([bad.status, bad.json.error?.code], 'advance_below >= hold_below (§8.3)').toEqual([422, 'validation_failed']);
  const check = await checkNumberRaw(shop.s, randomPhone(), g);
  expect(check.status, check.text.slice(0, 200)).toBe(200);
  expect(check.json.data).toMatchObject({ tier: 'new', delivered: 0, total: 0, blocked: false });
  const orderId = await manualOrder(shop, randomPhone());
  const release = await releaseRaw(shop.s, orderId, g);
  expect([release.status, release.json.error?.code]).toEqual([403, 'forbidden']);
  const phone = randomPhone();
  const first = await blockRaw(shop.s, phone, null, g);
  expect(first.status, first.text.slice(0, 200)).toBe(201);
  const again = await blockRaw(shop.s, `+88${phone}`, null, g);
  expect([again.status, again.json.error?.code], 'same number, other spelling').toEqual([409, 'already_blocked']);
});

test('UI custom role: nav shows "Fake order guard" and the page opens', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, guardian!.session);
  await page.goto(mUrl('/orders'));
  await expect(page.getByRole('heading', { name: /^Orders$/, level: 1 })).toBeVisible({ timeout: 20_000 });
  expect(await navLabels(page)).toContain('Fake order guard');
  await openGuard(page);
  await expect(noAccess(page)).toHaveCount(0);
  await expect(protectionTag(page, true)).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('owner UI: a rule toggle autosaves; "Reset to recommended" restores the defaults', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openGuard(page);
  const sw = ruleSwitch(page, RULE_TITLES[5]); // Limit orders per phone
  await expect(sw).toBeVisible();
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/fraud-guard\/settings$/.test(new URL(r.url()).pathname));
  await sw.click();
  expect((await saved).status()).toBe(200);
  expect((await guardSettings(shop.s)).daily_limit_enabled).toBe(false);

  const reset = page.waitForResponse((r) => r.request().method() === 'POST' && /\/fraud-guard\/settings\/reset$/.test(new URL(r.url()).pathname));
  await page.getByRole('button', { name: /Reset to recommended/ }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: /Reset/ }).last().click();
  expect((await reset).status()).toBe(200);
  expect(await guardSettings(shop.s)).toMatchObject({ daily_limit_enabled: true, daily_limit: 3, hold_below: 60, advance_below: 75, min_parcels: 3 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test.describe('Free shop (S166, Q198)', () => {
  let free: CommerceShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    free = await guardShop('fgf', 'free');
  });
  test.afterAll(() => free?.cleanup());

  test('reads 200; writes and check-a-number 402; a new number COD order needs no OTP and is never held', async () => {
    test.setTimeout(120_000);
    for (const path of ['/settings', '/overview', '/events', '/blocked-numbers']) {
      const r = await apiCall(free.s, 'GET', fpath(free.s, path));
      expect(r.status, `GET ${path}: ${r.text.slice(0, 200)}`).toBe(200);
    }
    for (const r of [await patchGuardRaw(free.s, { daily_limit: 5 }), await blockRaw(free.s, randomPhone()), await checkNumberRaw(free.s, randomPhone())]) {
      expect([r.status, r.json.error?.code], r.text.slice(0, 200)).toEqual([402, 'feature_not_in_plan']);
    }
    const r = await codCheckout(free, randomPhone());
    expect(r.status, `no OTP on Free: ${r.text.slice(0, 300)}`).toBe(201);
    const id = await orderIdByNumber(free.s, r.json.data.order.number as string);
    // a check without actions may or may not be written on Free; either way nothing is held (P88-15)
    const o = await waitGuard(free.s, id, 20_000).catch(() => merchantOrder(free.s, id));
    expect(o.guard?.hold ?? null, 'no checks with actions on Free').toBeNull();
    expect(['hold', 'advance']).not.toContain(o.guard?.decision);
    if (o.guard?.tier) expect(o.guard.tier, 'tiers still show (P88-15)').toBe('new');
    expect(o.status).toBe('pending');
  });

  test('UI: the guard page shows the plan note with "See plans"', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, free.s);
    await openGuard(page);
    await expect(planNote(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /See plans/ }).or(page.getByRole('button', { name: /See plans/ })).first()).toBeVisible();
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});
