import { expect, test } from '@playwright/test';
import { signInDashboard, unique } from '../support/api';
import { randomPhone } from '../support/commerce';
import {
  addCustomer,
  campaignShop,
  createCampaign,
  dialog,
  fillComposer,
  openComposer,
  orderAs,
  primaryAction,
  sendNow,
  sinkFor,
  unsubApi,
  unsubPage,
  waitCampaign,
  willGet,
  type CampaignShop,
} from '../support/campaigns';

/**
 * PHASE-8-5 QA gate regressions (docs/reviews/phase-8-5-qa.md). Independent tests (own data), so each bug reports on
 * its own; they fail until the finding is fixed.
 *  - P85-QA-1: the composer's confirm dialog shows the live recipient count (estimate refreshed after edits).
 *  - P85-QA-2: the storefront unsubscribe button shows the confirmation in place (no 404 after the server action).
 */
let shop: CampaignShop;
let code = '';

test.beforeAll(async () => {
  test.setTimeout(150_000);
  shop = await campaignShop('cmr', 'starter', 13);
  await addCustomer(shop.s, { name: 'Rafi Regress', phone: randomPhone(), accepts_marketing: true });
  await orderAs(shop, 'Ruma Regress', randomPhone()); // ordered today: excluded by the default "last 7 days" box
  const marker = unique('rg').replace(/[^a-z0-9]/gi, '');
  const c = await createCampaign(shop.s, { body: `Hi {name} ${marker}` });
  expect((await sendNow(shop.s, c.id)).status).toBe(202);
  await waitCampaign(shop.s, c.id);
  await expect.poll(async () => (await sinkFor(shop.s, c.id, marker)).length, { timeout: 20_000 }).toBe(2);
  code = (await sinkFor(shop.s, c.id, marker))[0].code!;
});
test.afterAll(() => shop?.cleanup());

test('P85-QA-1: confirm dialog recipients match "N customers will get this message"', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, shop.s);
  await openComposer(page);
  await fillComposer(page, { name: unique('Dialog '), channel: 'sms', body: 'Hi {name}, dialog check {shop_link}', skipRecent: false });
  await expect(willGet(page)).toContainText(/\b2 customers will get this message/i, { timeout: 15_000 });
  await page.waitForTimeout(1_500); // past the 600 ms estimate debounce
  await primaryAction(page).click();
  await expect(dialog(page)).toContainText(/Recipients\s*2\b/);
  await dialog(page).getByRole('button', { name: /^Cancel$/ }).click();
});

test('P85-QA-2: Unsubscribe / Subscribe again re-render the page in place (no 404)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(unsubPage(shop, code));
  await page.getByRole('button', { name: /^Unsubscribe$/ }).click();
  await expect.poll(async () => (await unsubApi(shop.apiHost, code)).json.data?.status, { timeout: 15_000 }).toBe('unsubscribed');
  await expect(page.getByText(/This page wandered off/)).toHaveCount(0);
  await expect(page.getByText(/You.re unsubscribed/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Subscribe again/ }).click();
  await expect(page.getByRole('button', { name: /^Unsubscribe$/ })).toBeVisible({ timeout: 15_000 });
});
