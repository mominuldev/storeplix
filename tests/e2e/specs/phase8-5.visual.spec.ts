import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard, unique } from '../support/api';
import { randomPhone } from '../support/commerce';
import {
  CAMPAIGNS,
  MARKETING,
  addCustomer,
  campaignShop,
  createCampaign,
  fillComposer,
  mUrl,
  openComposer,
  orderAs,
  sendNow,
  sinkFor,
  unsubPage,
  waitCampaign,
  type CampaignShop,
} from '../support/campaigns';
import { pageOverflow, watchConsole } from '../support/roles';

/**
 * PHASE-8-5 §11 QA `phase8-5.visual` + AC 3 / Q151: Marketing overview, campaigns list, composer (SMS and email
 * preview), campaign detail and the storefront unsubscribe page at 1280, 390 and 375 px: no horizontal page overflow,
 * no console errors; hidden items (WhatsApp, Automations tab, Carts recovered / Return on spend, top-up) absent.
 * Screenshots → test-results/phase8-5-visual/<width>/ (git-ignored) for the Figma review against `66:19179` / `70:19774`.
 */
const OUT = resolve(E2E_ROOT, 'test-results/phase8-5-visual');
const WIDTHS = [1280, 390, 375];

let shop: CampaignShop;
let sentId = '';
let code = '';

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await campaignShop('cmv', 'starter', 13);
  const marker = unique('vis').replace(/[^a-z0-9]/gi, '');
  await addCustomer(shop.s, { name: 'Rina Visual', phone: randomPhone(), accepts_marketing: true });
  await addCustomer(shop.s, { name: 'Sabbir Visual', phone: randomPhone(), accepts_marketing: true });
  await orderAs(shop, 'Tania Visual', randomPhone());
  const c = await createCampaign(shop.s, { name: 'Eid win-back', language: 'bn', body: `{name}, ঈদের অফার ${marker} {shop_link}` });
  expect((await sendNow(shop.s, c.id)).status).toBe(202);
  await waitCampaign(shop.s, c.id, ['sent']);
  sentId = c.id;
  await expect.poll(async () => (await sinkFor(shop.s, c.id, marker)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  code = (await sinkFor(shop.s, c.id, marker))[0].code!;
  await createCampaign(shop.s, { name: 'Draft newsletter', channel: 'email', subject: 'News', body: 'Hello {name}' });
});
test.afterAll(() => shop?.cleanup());

async function shot(page: Page, width: number, name: string, overflow: string[]) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const o = await pageOverflow(page);
  if (o) overflow.push(`${width}px ${name}: ${o}`);
  await page.screenshot({ path: `${OUT}/${width}/${name}.png`, fullPage: true });
}

for (const width of WIDTHS) {
  test(`Marketing pages + unsubscribe at ${width}px: no page overflow, no console errors`, async ({ page, context }) => {
    test.setTimeout(120_000);
    mkdirSync(`${OUT}/${width}`, { recursive: true });
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    const c = watchConsole(page);
    const overflow: string[] = [];
    await signInDashboard(context, shop.s);

    await page.goto(mUrl(MARKETING));
    await expect(page.getByRole('heading', { name: /^Marketing$/, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Eid win-back').first()).toBeVisible({ timeout: 30_000 }); // query retries on local sqlite locks
    for (const hidden of [/WhatsApp/, /Automations/, /Carts recovered/, /Return on spend/, /Top up/i, /Best week yet/]) {
      await expect(page.getByText(hidden), `hidden in 8.5: ${hidden}`).toHaveCount(0);
    }
    await shot(page, width, 'overview', overflow);

    await page.goto(mUrl(CAMPAIGNS));
    await expect(page.getByText('Draft newsletter').first()).toBeVisible({ timeout: 15_000 });
    await shot(page, width, 'campaigns-list', overflow);

    await openComposer(page);
    await expect(page.getByText(/WhatsApp/)).toHaveCount(0);
    await fillComposer(page, { name: 'Visual check', channel: 'sms', body: '{name}, ঈদের বিশেষ অফার! {shop_link}', english: false });
    await expect(page.getByText(/SMS per person/i).first()).toBeVisible();
    await shot(page, width, 'composer-sms', overflow);
    await fillComposer(page, { name: 'Visual check', channel: 'email', subject: 'Eid collection', body: 'Hello {name},\n\nOur Eid collection is here.' });
    await shot(page, width, 'composer-email', overflow);

    await page.goto(mUrl(`${CAMPAIGNS}/${sentId}`));
    await expect(page.getByRole('heading', { name: /Eid win-back/ })).toBeVisible({ timeout: 15_000 });
    await shot(page, width, 'campaign-detail', overflow);

    await page.goto(unsubPage(shop, code));
    await expect(page.getByRole('button', { name: /^Unsubscribe$|সাবস্ক্রিপশন|বন্ধ/ }).first()).toBeVisible({ timeout: 15_000 });
    await shot(page, width, 'unsubscribe', overflow);

    expect(overflow, overflow.join('\n')).toEqual([]);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
    test.info().annotations.push({ type: 'network', description: c.network.join('; ') || 'none' });
  });
}
