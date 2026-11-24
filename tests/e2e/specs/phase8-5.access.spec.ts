import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, createMember, signInDashboard, unique, type ThrowawayMember } from '../support/api';
import { randomPhone } from '../support/commerce';
import {
  CAMPAIGNS,
  MARKETING,
  addCustomer,
  campaignShop,
  createCampaign,
  estimate,
  mUrl,
  newCampaignButton,
  planNote,
  primaryAction,
  schedule,
  sendNow,
  testSend,
  atLocal,
  ALL,
  type CampaignShop,
} from '../support/campaigns';
import { noAccess, watchConsole } from '../support/roles';

/**
 * PHASE-8-5 §11 QA `phase8-5.access` (§2.1, §2.2, P85-13, P85-23, S120, S122, S126):
 *  - Free shop: allowance 0 → send now / schedule / test send 402 `plan_limit_reached` (`upgrade_plan` starter,
 *    `details.campaign_sms_per_month`); UI plan note "Campaigns are part of the Starter plan." + See plans; create/send
 *    disabled. Starter shop: estimate allowance limit 1 000 SMS parts, 5 000 emails.
 *  - Staff (no `marketing.manage`): 403 on every §6.1 route and the dev sink; `/auth/me` lacks the key; the Marketing
 *    campaigns pages show the no-access state.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const expect402 = (r: { status: number; json: Json }, key = 'campaign_sms_per_month') => {
  expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([402, 'plan_limit_reached']);
  expect([r.json.error.details?.upgrade_plan].flat()).toContain('starter');
  expect(r.json.error.details?.[key], `details.${key}`).toMatchObject({ limit: 0 });
};

test.describe('Free plan', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CampaignShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    shop = await campaignShop('cmf', 'free', 13);
    await addCustomer(shop.s, { name: 'Free Customer', phone: randomPhone(), email: `${unique('fc-')}@example.com`, accepts_marketing: true });
  });
  test.afterAll(() => shop?.cleanup());

  test('API: drafts allowed, send / schedule / test → 402 plan_limit_reached (P85-13, S122)', async () => {
    const s = shop.s;
    const sms = await createCampaign(s, { name: unique('Free sms '), body: 'Hello {name}' });
    expect402(await sendNow(s, sms.id));
    expect402(await schedule(s, sms.id, atLocal(shop.offset, '15:00')));
    expect402(await testSend(s, sms.id));
    const mail = await createCampaign(s, { channel: 'email', name: unique('Free mail '), subject: 'Hi', body: 'Hello {name}' });
    expect402(await sendNow(s, mail.id), 'campaign_emails_per_month');
    const est = await estimate(s, { channel: 'sms', language: 'en', body: 'Hello {name}', audience: ALL });
    expect(est.status, JSON.stringify(est.json)).toBe(200);
    expect(est.json.data.allowance.limit).toBe(0);
  });

  test('UI: plan note + See plans, create and send disabled (§8)', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    await page.goto(mUrl(CAMPAIGNS));
    await expect(planNote(page)).toBeVisible({ timeout: 15_000 });
    const see = page.getByRole('link', { name: /See plans/ }).first();
    await expect(see).toBeVisible();
    await expect(see).toHaveAttribute('href', /\/settings\/plan/);
    const nb = newCampaignButton(page);
    if (await nb.count()) {
      const disabled = (await nb.isDisabled().catch(() => false)) || (await nb.getAttribute('aria-disabled')) === 'true';
      expect(disabled, '"+ New campaign" disabled on Free').toBe(true);
    }
    await page.goto(mUrl(`${CAMPAIGNS}/new`));
    await expect(planNote(page)).toBeVisible({ timeout: 15_000 });
    await expect(primaryAction(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: /Send test to me/ })).toBeDisabled();
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});

test('Starter: estimate reports the monthly allowances (1 000 SMS parts / 5 000 emails, P85-13)', async () => {
  test.setTimeout(120_000);
  const shop = await campaignShop('cmst', 'starter', 13);
  try {
    await addCustomer(shop.s, { name: 'Starter Customer', phone: randomPhone(), accepts_marketing: true });
    const sms = await estimate(shop.s, { channel: 'sms', language: 'bn', body: 'হ্যালো {name}', audience: ALL });
    expect(sms.status, JSON.stringify(sms.json)).toBe(200);
    expect(sms.json.data).toMatchObject({ recipients: 1, encoding: expect.stringMatching(/ucs/i) });
    expect(sms.json.data.allowance).toMatchObject({ limit: 1000, used: 0 });
    expect(sms.json.data.allowance.after).toBe(1000 - sms.json.data.total_parts);
    const mail = await estimate(shop.s, { channel: 'email', language: 'en', subject: 'Hi', body: 'Hello {name}', audience: ALL });
    expect(mail.status, JSON.stringify(mail.json)).toBe(200);
    expect(mail.json.data.allowance.limit).toBe(5000);
  } finally {
    shop.cleanup();
  }
});

test.describe('staff', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CampaignShop;
  let staff: ThrowawayMember;
  let campaignId = '';
  let customerId = '';
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    shop = await campaignShop('cmsf', 'starter', 13);
    customerId = (await addCustomer(shop.s, { name: 'Staff Target', phone: randomPhone(), accepts_marketing: true })).id;
    campaignId = (await createCampaign(shop.s, { name: unique('Owner draft '), body: 'Hello {name}' })).id;
    staff = await createMember(shop.s, 'staff');
  });
  test.afterAll(async () => {
    await staff?.cleanup();
    shop?.cleanup();
  });

  test('API: staff gets 403 on every campaign route and the dev sink (§2.1, S120)', async () => {
    const s = staff.session;
    const b = `/stores/${shop.s.storeId}`;
    const c = `${b}/campaigns/${campaignId}`;
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `${b}/marketing/overview?range=30d`],
      ['GET', `${b}/campaigns`],
      ['POST', `${b}/campaigns`, { name: 'x', channel: 'sms', language: 'en', audience: ALL, body: 'x' }],
      ['GET', c],
      ['PATCH', c, { name: 'y', revision: 1 }],
      ['DELETE', c],
      ['POST', `${b}/campaigns/audience-preview`, { channel: 'sms', audience: ALL }],
      ['POST', `${b}/campaigns/estimate`, { channel: 'sms', language: 'en', body: 'x', audience: ALL }],
      ['POST', `${c}/test`, {}],
      ['POST', `${c}/schedule`, { scheduled_at: atLocal(shop.offset, '15:00') }],
      ['POST', `${c}/send`, {}],
      ['POST', `${c}/unschedule`, {}],
      ['POST', `${c}/cancel`, {}],
      ['POST', `${c}/duplicate`, {}],
      ['GET', `${c}/recipients`],
      ['GET', `/dev/stores/${shop.s.storeId}/message-sink`],
    ];
    const got: string[] = [];
    for (const [m, p, body] of calls) {
      const r = await apiCall(s, m, p, { ...(body === undefined ? {} : { json: body }), headers: { 'Idempotency-Key': randomUUID() } });
      got.push(`${m} ${p} → ${r.status}`);
    }
    expect(got).toEqual(calls.map(([m, p]) => `${m} ${p} → 403`));
    // The customer toggle is `perm:customers.edit` (§2.1), which system Staff has: allowed, and audited as staff.
    const toggle = await api(s, 'POST', `${b}/customers/${customerId}/marketing-opt-out`, { channel: 'sms' });
    expect([200, 201], JSON.stringify(toggle.json)).toContain(toggle.status);
    const me = await api(s, 'GET', '/auth/me');
    const mine = (me.json.data.tenants as Json[]).find((t) => t.id === shop.s.tenantId)!;
    expect(mine.permissions).not.toContain('marketing.manage');
    // The owner's draft is untouched.
    expect((await api(shop.s, 'GET', c)).json.data.status).toBe('draft');
  });

  test('UI: staff sees the no-access state on Marketing overview, campaigns and composer', async ({ page, context }) => {
    test.setTimeout(90_000);
    await signInDashboard(context, staff.session);
    // `/marketing` without marketing.manage falls back to the Coupons list (App.tsx MarketingIndex): no campaign UI there.
    await page.goto(mUrl(MARKETING));
    await expect(page).toHaveURL(/\/marketing\/coupons$/, { timeout: 15_000 });
    await expect(page.getByText(/New campaign|Campaigns are part/)).toHaveCount(0);
    for (const path of [CAMPAIGNS, `${CAMPAIGNS}/new`, `${CAMPAIGNS}/${campaignId}`]) {
      await page.goto(mUrl(path));
      await expect(noAccess(page), path).toBeVisible({ timeout: 15_000 });
    }
  });
});
