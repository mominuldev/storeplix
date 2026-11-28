import { expect, test, type Page } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { purchasingShop } from '../support/purchasing';
import type { CommerceShop } from '../support/commerce';
import { watchApiErrors, watchConsole } from '../support/roles';
import { cleanupSmsShop, messages, messagesRaw, openSms, panel, seedLogRow, testSmsRaw, verifyOwnerPhone } from '../support/sms';

/**
 * PHASE-8-9A §9, §12.4 (P89A-19, P89A-21, S209, S217): SMS log — empty state "No SMS sent yet" + Send test SMS; rows of
 * the last 30 days by default (a 45-day-old row appears after widening From, a 100-day-old one never); masked phones;
 * checkout codes "Checkout code (hidden)"; status pills (Failed + "Provider error", Skipped + "No SMS left"); purpose
 * chips (Order, OTP, Campaign, Test shown once a test SMS exists); status select; exact phone search (bad number →
 * "Enter a full phone number"); no match → "No messages match these filters" + Clear filters.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
const FAILED_TO = '8801711222333';
test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('smslog', 'starter', 2);
});
test.afterAll(() => cleanupSmsShop(shop));

const table = (page: Page) => page.getByRole('table', { name: 'SMS log' });
const dataRows = (page: Page) => table(page).locator('tbody tr');
const chip = (page: Page, name: string) => page.getByRole('group', { name: 'Purpose' }).getByRole('button', { name, exact: true });

test('empty state: No SMS sent yet + Send test SMS', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openSms(page, 'log');
  const log = panel(page, 'SMS log');
  await expect(log).toContainText('Every SMS your shop sent in the last 90 days. Times are Bangladesh time.');
  await expect(log).toContainText('No SMS sent yet', { timeout: 20_000 });
  await expect(log.getByRole('button', { name: 'Send test SMS' })).toBeVisible();
  await expect(chip(page, 'Test')).toHaveCount(0);
});

test('rows, masking, statuses, chips, status select, phone search, date range, clear filters', async ({ page, context }) => {
  test.setTimeout(120_000);
  verifyOwnerPhone(shop.s, shop.t.email);
  expect((await testSmsRaw(shop.s, 'en')).status).toBe(200);
  seedLogRow(shop.s, { purpose: 'order_confirmed', status: 'failed', to: FAILED_TO, preview: 'QA failed order text' });
  seedLogRow(shop.s, { purpose: 'campaign', status: 'skipped', to: '8801711444555', preview: 'QA campaign text' });
  seedLogRow(shop.s, { purpose: 'checkout_otp', status: 'sent', to: '8801711666777', preview: 'SHOULD NEVER SHOW 482913', charged: 'allowance' });
  seedLogRow(shop.s, { purpose: 'order_shipped', status: 'sent', to: '8801711888999', preview: 'QA 45 days old', charged: 'allowance', daysAgo: 45 });
  seedLogRow(shop.s, { purpose: 'order_shipped', status: 'sent', to: '8801711000111', preview: 'QA 100 days old', charged: 'allowance', daysAgo: 100 });

  // API: OTP text never leaves the server (S217); the 100-day row is outside the window.
  const all = await messages(shop.s, 'filter[from]=' + new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10));
  expect(all.find((r) => r.purpose === 'checkout_otp')?.body_preview ?? null).toBeNull();
  expect(all.some((r) => String(r.body_preview).includes('100 days'))).toBe(false);
  expect(all.every((r) => /•••/.test(r.to_masked))).toBe(true);

  const c = watchConsole(page);
  const apiErr = watchApiErrors(page);
  await signInDashboard(context, shop.s);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSms(page, 'log');
  await expect(dataRows(page)).toHaveCount(4, { timeout: 20_000 }); // test, failed, skipped, otp (30-day default)
  await expect(table(page)).toContainText('01711-•••333');
  await expect(table(page)).toContainText('Checkout code (hidden)');
  await expect(table(page)).not.toContainText('482913');
  await expect(table(page)).toContainText('Provider error');
  await expect(table(page)).toContainText('No SMS left');
  await expect(panel(page, 'SMS log')).toContainText('Showing 50 per page');
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await expect(chip(page, 'Test')).toBeVisible();

  await chip(page, 'OTP').click();
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first()).toContainText('OTP');
  await chip(page, 'Campaign').click();
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first()).toContainText('Skipped');
  await chip(page, 'Test').click();
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first()).toContainText('Allowance');
  await chip(page, 'All').click();

  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Status: Failed' });
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first()).toContainText('Failed');
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Status: All' });

  const search = page.getByRole('searchbox', { name: 'Search by phone number' });
  await search.fill('12345');
  await search.press('Enter');
  await expect(panel(page, 'SMS log')).toContainText('Enter a full phone number');
  await search.fill('01711222333');
  await search.press('Enter');
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first()).toContainText('01711-•••333');

  await search.fill('01711999000');
  await search.press('Enter');
  await expect(panel(page, 'SMS log')).toContainText('No messages match these filters');
  await panel(page, 'SMS log').getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toHaveValue('');
  await expect(dataRows(page)).toHaveCount(4);

  const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  await page.getByLabel('From', { exact: true }).fill(from);
  await expect(dataRows(page)).toHaveCount(5);
  await expect(table(page)).toContainText('QA 45 days old');
  await expect(table(page)).not.toContainText('QA 100 days old');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
  expect(apiErr.filter((e) => !/filter%5Bphone%5D=12345|filter\[phone\]=12345/.test(e)), apiErr.join('\n')).toEqual([]);

  // Server-side phone validation (422) for a value the client would never send.
  const bad = await messagesRaw(shop.s, 'filter[phone]=12345');
  expect(bad.status).toBe(422);
});
