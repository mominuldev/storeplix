import { expect, test } from '@playwright/test';
import { api, signInDashboard, unique } from '../support/api';
import { randomPhone } from '../support/commerce';
import {
  CAMPAIGNS,
  addCustomer,
  atLocal,
  campaignShop,
  cancel,
  createCampaign,
  dialog,
  fillComposer,
  getCampaign,
  listCampaigns,
  localTime,
  mUrl,
  openComposer,
  primaryAction,
  schedule,
  sendNow,
  unschedule,
  type CampaignShop,
} from '../support/campaigns';

/**
 * PHASE-8-5 §11 QA `phase8-5.schedule` (P85-15 quiet hours, P85-16 bounds, P85-17 states, S124). No dev clock exists
 * for campaigns, so the specs move the **store timezone** instead: a fixed-offset zone where it is ~13:00 locally
 * ("day" shop) or ~02:00 ("night" shop) whenever the suite runs; quiet hours are evaluated in store time.
 *  - Day shop: schedule at 15:00 local → `scheduled`; list filter; unschedule → `draft`; reschedule; Cancel from the
 *    detail page → `cancelled`; cancel again 409 `invalid_state_transition`; scheduling at 22:30 / tomorrow 08:30
 *    local → 422 `campaign_quiet_hours` (`details.allowed_from`); < now + 5 min or > now + 90 days → 422; missing
 *    `Idempotency-Key` → 400/428 `idempotency_key_required`.
 *  - Night shop: Send now → 422 `campaign_quiet_hours`; the composer shows the quiet-hours error inline; scheduling at
 *    10:00 local is fine.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const quiet = (r: { status: number; json: Json }) => {
  expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([422, 'campaign_quiet_hours']);
  expect(r.json.error.details?.allowed_from, 'details.allowed_from').toBeTruthy();
};

test.describe('day shop (13:00 store time)', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CampaignShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    shop = await campaignShop('cms', 'starter', 13);
    await addCustomer(shop.s, { name: 'Sumi Sched', phone: randomPhone(), accepts_marketing: true });
  });
  test.afterAll(() => shop?.cleanup());

  test('schedule → list → unschedule → reschedule → cancel from the detail page (P85-16, P85-17)', async ({ page, context }) => {
    test.setTimeout(120_000);
    const s = shop.s;
    expect(Number(localTime(new Date(), shop.offset).slice(0, 2)), `store local time ${localTime(new Date(), shop.offset)}`).toBeGreaterThanOrEqual(12);
    const c = await createCampaign(s, { name: unique('Sched '), body: 'Weekend sale at {shop_link}' });
    const at = atLocal(shop.offset, '15:00');
    const r = await schedule(s, c.id, at);
    expect(r.status, r.text).toBe(200);
    expect(r.json.data.status).toBe('scheduled');
    expect(new Date(r.json.data.scheduled_at).toISOString()).toBe(new Date(at).toISOString());
    expect((await listCampaigns(s, 'filter[status]=scheduled')).map((x) => x.id)).toContain(c.id);
    expect((await listCampaigns(s, 'filter[status]=draft')).map((x) => x.id)).not.toContain(c.id);

    const un = await unschedule(s, c.id);
    expect([un.status, un.json.data?.status]).toEqual([200, 'draft']);
    const again = await schedule(s, c.id, atLocal(shop.offset, '16:30'));
    expect([again.status, again.json.data?.status], again.text).toEqual([200, 'scheduled']);

    await signInDashboard(context, s);
    await page.goto(mUrl(`${CAMPAIGNS}/${c.id}`));
    await expect(page.getByText(/Scheduled/).first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Cancel( campaign)?$/ }).first().click();
    const dlg = dialog(page);
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /Cancel campaign|Yes|Confirm/ }).first().click();
    await expect(page.getByText(/Cancelled/).first()).toBeVisible({ timeout: 15_000 });
    const after = await getCampaign(s, c.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelled_at).toBeTruthy();

    const twice = await cancel(s, c.id);
    expect([twice.status, twice.json.error?.code]).toEqual([409, 'invalid_state_transition']);
    const edit = await api(s, 'PATCH', `/stores/${s.storeId}/campaigns/${c.id}`, { name: 'x', revision: after.revision });
    expect([edit.status, edit.json.error?.code]).toEqual([409, 'invalid_state_transition']);
  });

  test('quiet hours and schedule bounds are enforced server-side in store time (P85-15, P85-16, S124)', async () => {
    const s = shop.s;
    const c = await createCampaign(s, { name: unique('Bounds '), body: 'Hello {name}' });
    quiet(await schedule(s, c.id, atLocal(shop.offset, '22:30')));
    quiet(await schedule(s, c.id, atLocal(shop.offset, '08:30', 1)));
    quiet(await schedule(s, c.id, atLocal(shop.offset, '21:00')));

    const soon = await schedule(s, c.id, new Date(Date.now() + 2 * 60_000).toISOString());
    expect(soon.status, soon.text).toBe(422);
    const far = await schedule(s, c.id, atLocal(shop.offset, '12:00', 92));
    expect(far.status, far.text).toBe(422);
    const noKey = await schedule(s, c.id, atLocal(shop.offset, '15:00'), null);
    expect([400, 428], noKey.text).toContain(noKey.status);
    expect(noKey.json.error?.code).toBe('idempotency_key_required');

    expect((await getCampaign(s, c.id)).status, 'all refusals left it a draft').toBe('draft');
    const ok = await schedule(s, c.id, atLocal(shop.offset, '09:30', 1));
    expect([ok.status, ok.json.data?.status], ok.text).toEqual([200, 'scheduled']);
    expect((await cancel(s, c.id)).status).toBe(200);
  });
});

test.describe('night shop (02:00 store time)', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CampaignShop;
  test.beforeAll(async () => {
    test.setTimeout(150_000);
    shop = await campaignShop('cmn', 'starter', 2);
    await addCustomer(shop.s, { name: 'Nila Night', phone: randomPhone(), accepts_marketing: true });
  });
  test.afterAll(() => shop?.cleanup());

  test('API: Send now inside 21:00–09:00 → 422 campaign_quiet_hours; scheduling at 10:00 is fine', async () => {
    const s = shop.s;
    const c = await createCampaign(s, { name: unique('Night '), body: 'Hello {name}' });
    quiet(await sendNow(s, c.id));
    expect((await getCampaign(s, c.id)).status).toBe('draft');
    const ok = await schedule(s, c.id, atLocal(shop.offset, '10:00'));
    expect([ok.status, ok.json.data?.status], ok.text).toEqual([200, 'scheduled']);
    expect((await cancel(s, c.id)).status).toBe(200);
  });

  test('UI: the composer shows the quiet-hours error inline on Send now (§8.3 step 4)', async ({ page, context }) => {
    test.setTimeout(90_000);
    await signInDashboard(context, shop.s);
    await openComposer(page);
    await fillComposer(page, { name: unique('Night UI '), channel: 'sms', body: 'Hello {name}' });
    await primaryAction(page).click();
    const dlg = dialog(page);
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /^Send/ }).click();
    await expect(page.getByText(/quiet hours|21:00|9(:00)?\s?(AM|am)|09:00/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/marketing\/campaigns\/(new|[0-9A-Za-z]{26}\/edit)$/);
  });
});
