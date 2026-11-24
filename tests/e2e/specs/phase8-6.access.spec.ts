import { expect, test } from '@playwright/test';
import { api, createMember, signInDashboard, type ThrowawayMember } from '../support/api';
import { randomPhone, setPlan } from '../support/commerce';
import {
  AUTOMATIONS,
  RECOVERY,
  RUN_LOG,
  apath,
  automationShop,
  automationsPlanNote,
  createAutomation,
  createAutomationRaw,
  deliveredOrder,
  elapseWait,
  enableRaw,
  listAutomations,
  mUrl,
  openAutomations,
  pausedPill,
  runsOf,
  startRecipe,
  waitRun,
  type AutomationShop,
} from '../support/automations';
import { noAccess, watchConsole } from '../support/roles';

/**
 * PHASE-8-6 §13 QA `phase8-6.access` (§2, P86-17, P86-18, S131, S135):
 *  - Free: `sms_automation` is not in the plan → create 402 `feature_not_in_plan` (`details.feature`); the page shows
 *    "Automations are part of the Starter plan." + See plans and no usable "Use recipe".
 *  - Downgrade Starter → Free (the `sms_automation` loss): automations keep settings and toggle state, list shows
 *    `paused_reason: plan` + the "Paused — not in your plan" pill; a new trigger creates **no** run; a waiting run ends
 *    `stopped/plan` at its next step; enable → 402.
 *  - Staff (no `marketing.manage`): 403 on every §9.1 route; no-access state on the Automations pages.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const expect402 = (r: { status: number; json: Json }) => {
  expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([402, 'feature_not_in_plan']);
  expect([r.json.error.details?.feature].flat(), 'details.feature (the shared FeatureGate sends a list)').toContain('sms_automation');
};

test.describe('Free plan', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: AutomationShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    shop = await automationShop('aaf', 'free', 13);
  });
  test.afterAll(() => shop?.cleanup());

  test('API: create → 402 feature_not_in_plan; reads still 200 (P86-17)', async () => {
    expect402(await createAutomationRaw(shop.s, 'thank_you'));
    expect402(await createAutomationRaw(shop.s, 'checkout_recovery'));
    const { data, meta } = await listAutomations(shop.s);
    expect(data).toHaveLength(0);
    expect((meta.recipes as Json[]).length).toBe(5);
  });

  test('UI: plan note + See plans; recipes cannot be started (§10)', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    await openAutomations(page);
    await expect(automationsPlanNote(page)).toBeVisible({ timeout: 15_000 });
    const see = page.getByRole('link', { name: /See plans/ }).first();
    await expect(see).toHaveAttribute('href', /\/settings\/plan/);
    const use = page.getByRole('button', { name: /Use recipe/ });
    for (let i = 0; i < (await use.count()); i++) await expect(use.nth(i)).toBeDisabled();
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});

test.describe('downgrade pauses automations', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: AutomationShop;
  let thanks: Json;
  let waiting: Json;
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await automationShop('aad', 'starter', 13);
    thanks = await startRecipe(shop.s, 'thank_you', { delay_hours: 1 });
    const order = await deliveredOrder(shop, randomPhone(), 'Before Downgrade');
    waiting = await waitRun(shop.s, thanks.id, (x) => (x.subject?.id === order.id || x.subject?.label === order.number) && x.status === 'waiting', 90_000);
    await createAutomation(shop.s, 'return_flag'); // a draft, for the enable check
    setPlan(shop.s, 'free');
  });
  test.afterAll(() => shop?.cleanup());

  test('settings and toggle kept, paused_reason plan, no new run, waiting run → stopped/plan, enable 402 (S135)', async () => {
    test.setTimeout(150_000);
    const { data } = await listAutomations(shop.s);
    const t = data.find((a) => a.id === thanks.id)!;
    expect([t.status, t.paused_reason]).toEqual(['on', 'plan']);
    expect(t.settings?.delay_hours).toBe(1);

    const before = (await runsOf(shop.s, thanks.id)).length;
    await deliveredOrder(shop, randomPhone(), 'After Downgrade');
    await new Promise((r) => setTimeout(r, 6_000));
    expect((await runsOf(shop.s, thanks.id)).length, 'no run while not in plan').toBe(before);

    elapseWait(waiting.id);
    const stopped = await waitRun(shop.s, thanks.id, (x) => x.id === waiting.id && x.status === 'stopped', 60_000);
    expect(stopped.outcome_reason).toBe('plan');

    const draft = data.find((a) => a.recipe === 'return_flag')!;
    const en = await enableRaw(shop.s, draft.id);
    expect([en.status, en.json.error?.code], JSON.stringify(en.json)).toEqual([402, 'feature_not_in_plan']);
  });

  test('UI: "Paused — not in your plan" pill on the automation row (§10)', async ({ page, context }) => {
    test.setTimeout(90_000);
    await signInDashboard(context, shop.s);
    await openAutomations(page);
    await expect(pausedPill(page)).toBeVisible({ timeout: 20_000 });
    await expect(automationsPlanNote(page)).toBeVisible();
  });
});

test.describe('staff', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: AutomationShop;
  let staff: ThrowawayMember;
  let auto: Json;
  let runId = '';
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await automationShop('aas', 'starter', 13);
    auto = await startRecipe(shop.s, 'thank_you', { delay_hours: 0 });
    const order = await deliveredOrder(shop, randomPhone(), 'Staff Fixture');
    runId = (await waitRun(shop.s, auto.id, (x) => x.subject?.id === order.id || x.subject?.label === order.number, 90_000)).id;
    staff = await createMember(shop.s, 'staff');
  });
  test.afterAll(async () => {
    await staff?.cleanup();
    shop?.cleanup();
  });

  test('API: 403 on every §9.1 route; /auth/me lacks marketing.manage (P86-18, S131)', async () => {
    const s = staff.session;
    const a = (rest = '') => apath(s, rest);
    const routes: [string, string, unknown?][] = [
      ['GET', a()],
      ['POST', a(), { recipe: 'low_stock' }],
      ['GET', a(`/${auto.id}`)],
      ['PATCH', a(`/${auto.id}`), { name: 'Staff edit', revision: auto.revision }],
      ['POST', a(`/${auto.id}/enable`), {}],
      ['POST', a(`/${auto.id}/disable`), {}],
      ['DELETE', a(`/${auto.id}`)],
      ['POST', a(`/${auto.id}/dry-run`), {}],
      ['POST', a(`/${auto.id}/test-message`), { step: 1 }],
      ['GET', a(`/${auto.id}/stats?days=14`)],
      ['GET', `/stores/${s.storeId}/automation-runs`],
      ['GET', `/stores/${s.storeId}/automation-runs/${runId}`],
    ];
    const bad: string[] = [];
    for (const [m, p, b] of routes) {
      const r = await api(s, m, p, b);
      if (r.status !== 403) bad.push(`${m} ${p} → ${r.status}`);
    }
    expect(bad).toEqual([]);
    const me = await api(s, 'GET', '/auth/me');
    expect(JSON.stringify(me.json)).not.toContain('marketing.manage');
    expect((await api(shop.s, 'GET', a(`/${auto.id}`))).json.data.status, 'owner sees it unchanged').toBe('on');
  });

  test('UI: Automations, editor, recovery page and run log show the no-access state', async ({ page, context }) => {
    test.setTimeout(90_000);
    await signInDashboard(context, staff.session);
    for (const path of [AUTOMATIONS, `${AUTOMATIONS}/${auto.id}`, RECOVERY, RUN_LOG]) {
      await page.goto(mUrl(path));
      await expect(noAccess(page), path).toBeVisible({ timeout: 15_000 });
    }
  });
});
