import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, signInDashboard } from '../support/api';
import { adminLogin, adminUrl, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import type { CommerceShop } from '../support/commerce';
import { purchasingShop } from '../support/purchasing';
import { pageOverflow, watchConsole } from '../support/roles';
import { cleanupSmsShop, editor, openSms, panel, randomSenderId, requestSenderIdRaw, seedLogRow, smsTabs, testSmsRaw, verifyOwnerPhone, type SmsTab } from '../support/sms';

/**
 * PHASE-8-9A §12.7, §17 AC 7 (Figma 31:5120 / 2081:1197 overview, 2075:50213 templates, 2075:50625 sender ID,
 * 2075:51037 / 2081:1561 log, 2075:51449 buy credits, 2087:7872 admin queue) at 1440 and 390 px: no horizontal page
 * scroll, no console errors, tabs scroll at 390, the template editor is a full-width sheet at 390, the log becomes cards
 * at 390. Screenshots: tests/e2e/test-results/phase8-9a-visual/{1440,390}/.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let admin: AdminSession;
const SHOTS = resolve(E2E_ROOT, 'test-results/phase8-9a-visual');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('smsvis', 'starter', 2);
  verifyOwnerPhone(shop.s, shop.t.email);
  expect((await testSmsRaw(shop.s, 'bn')).status).toBe(200);
  seedLogRow(shop.s, { purpose: 'order_confirmed', status: 'failed', to: '8801711222333', preview: 'QA visual failed' });
  seedLogRow(shop.s, { purpose: 'checkout_otp', status: 'sent', to: '8801711666777', preview: 'x', charged: 'allowance' });
  expect((await requestSenderIdRaw(shop.s, randomSenderId())).status).toBe(201);
  reseedSuperAdmin();
  admin = await adminLogin('admin-super-p89a-vis');
});
test.afterAll(() => cleanupSmsShop(shop));

async function shot(page: Page, width: number, name: string): Promise<void> {
  const dir = resolve(SHOTS, String(width));
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}
const noOverflow = async (page: Page, where: string) => expect(await pageOverflow(page), `${where}: no horizontal scroll`).toBeNull();

for (const width of [1440, 390]) {
  test(`${width} px: every SMS tab, the template editor, the test SMS dialog`, async ({ page, context }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    const tabs: Array<[SmsTab, string, () => Promise<void>]> = [
      ['overview', '01-overview', async () => void (await expect(panel(page, 'SMS credits')).toBeVisible())],
      ['templates', '02-templates', async () => void (await expect(page.getByRole('list', { name: 'SMS templates' }).getByRole('listitem')).toHaveCount(8))],
      ['sender-id', '04-sender-id', async () => void (await expect(panel(page, 'Pending request')).toBeVisible())],
      ['log', '05-log', async () => void (await expect(page.getByText('Checkout code (hidden)').filter({ visible: true }).first()).toBeVisible())],
      ['credits', '06-buy-credits', async () => void (await expect(panel(page, 'Order summary')).toBeVisible())],
    ];
    for (const [tab, name, ready] of tabs) {
      await openSms(page, tab);
      await ready();
      await noOverflow(page, `${tab} ${width}`);
      await shot(page, width, name);
    }
    if (width < 768) {
      // Tabs scroll horizontally inside the strip; the log is a card list; header buttons stack.
      const strip = smsTabs(page);
      const sw = await strip.evaluate((el) => el.scrollWidth > el.clientWidth || getComputedStyle(el).overflowX === 'auto');
      expect(sw, 'tab strip scrolls').toBe(true);
      await openSms(page, 'log');
      await expect(page.getByRole('table', { name: 'SMS log' })).toBeHidden();
      await expect(page.getByRole('list', { name: 'SMS log' })).toBeVisible();
    }

    await openSms(page, 'templates', '&key=order_confirmed');
    const ed = editor(page);
    await expect(ed.getByRole('textbox', { name: 'Message' })).toBeVisible();
    if (width < 768) {
      const box = await page.getByRole('dialog', { name: 'Edit template' }).boundingBox();
      expect(box!.width, '390 px: the editor is a full-width sheet').toBeGreaterThanOrEqual(width - 2);
    } else {
      await expect(page.getByRole('region', { name: 'Edit template' })).toBeVisible();
    }
    await shot(page, width, '03-template-editor');
    await page.keyboard.press('Escape');

    await openSms(page);
    await page.getByRole('region', { name: 'SMS', exact: true }).getByRole('button', { name: 'Send test SMS' }).click();
    await expect(page.getByRole('dialog', { name: 'Send test SMS' })).toBeVisible();
    await noOverflow(page, `test dialog ${width}`);
    await shot(page, width, '07-test-sms-dialog');
    await page.getByRole('dialog', { name: 'Send test SMS' }).getByRole('button', { name: 'Cancel' }).click();
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });

  test(`${width} px: super-admin sender ID queue and drawer`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const c = watchConsole(page);
    await signInAdminApp(context, admin);
    await page.goto(`${adminUrl}/sender-ids`);
    await expect(page.getByRole('heading', { name: 'Sender ID requests' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('QA smsvis shop').first()).toBeVisible();
    await noOverflow(page, `admin queue ${width}`);
    await shot(page, width, '08-admin-queue');
    await page.getByText('QA smsvis shop').first().click();
    await expect(page.getByRole('dialog').filter({ hasText: 'Before you approve' })).toBeVisible();
    await shot(page, width, '09-admin-drawer');
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
}
