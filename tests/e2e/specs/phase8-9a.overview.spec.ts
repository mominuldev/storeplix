import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { mUrl } from '../support/locations';
import { watchApiErrors, watchConsole } from '../support/roles';
import { purchasingShop } from '../support/purchasing';
import type { CommerceShop } from '../support/commerce';
import { cleanupSmsShop, messages, msisdn, openSms, overview, panel, smsMark, smsTabs, testSmsRaw, verifyOwnerPhone, waitSms } from '../support/sms';

/**
 * PHASE-8-9A §12.1, §12.6, §6.2 (P89A-1, P89A-2, P89A-24, Q271, Q272): Integrations → Messaging → SMS card → overview;
 * header (Active, Messaging, description, sender line), Automatic messages (one row per event, Checkout OTP read-only, no
 * "Delivered" row), Sending rules (quiet hours read-only), SMS credits, This month. Send test SMS: unverified phone →
 * "Verify your phone in your profile first"; verified → toast "Test SMS sent to …", the log driver got the fixed text
 * with the "{Shop}: " prefix, the SMS log lists it as "Test", charged from the allowance.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('smsov', 'starter', 5);
});
test.afterAll(() => cleanupSmsShop(shop));

test('Integrations: Messaging chip + SMS card → Manage opens /integrations/sms', async ({ page, context }) => {
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(mUrl('/integrations'));
  await expect(page.getByRole('heading', { name: 'Messaging' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Storeplix SMS').first()).toBeVisible();
  await expect(page.getByText('Storeplix SMS · BTRC-approved')).toBeVisible();
  // "Messaging" filter chip shows only the Messaging section.
  await page.getByRole('button', { name: /^Messaging/ }).or(page.getByRole('radio', { name: /^Messaging/ })).or(page.getByRole('tab', { name: /^Messaging/ })).first().click();
  await expect(page.getByRole('heading', { name: 'Couriers' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Manage SMS' }).click();
  await expect(page).toHaveURL(/\/integrations\/sms$/);
  await expect(page.getByRole('heading', { name: 'SMS', level: 1 })).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('overview: header, automatic messages, sending rules, credits and this month', async ({ page, context }) => {
  const apiErrors = watchApiErrors(page);
  await signInDashboard(context, shop.s);
  await openSms(page);
  const nav = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(nav).toContainText('Integrations');
  await expect(nav).toContainText('Messaging');
  const header = page.getByRole('region', { name: 'SMS', exact: true });
  await expect(header).toContainText('Active');
  await expect(header).toContainText('Messaging');
  await expect(header).toContainText('nothing to connect');
  await expect(header).toContainText('Sender: Storeplix');
  await expect(header.getByRole('button', { name: 'Buy credits' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Send test SMS' })).toBeVisible();
  await expect(smsTabs(page).getByRole('tab')).toHaveText(['Overview', 'Templates', 'Sender ID', 'SMS log', 'Buy credits']);

  const auto = panel(page, 'Automatic messages');
  await expect(auto).toContainText('Bangla uses about 2× the credits of English.');
  const rows = auto.getByRole('list', { name: 'Automatic messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(8); // 7 events + checkout OTP
  await expect(auto).toContainText('Read-only');
  await expect(auto.getByRole('link', { name: 'Managed by Fake order guard' })).toHaveAttribute('href', '/orders/fraud-guard');
  await expect(auto.getByText(/Delivered/)).toHaveCount(0);
  await expect(auto.getByRole('switch', { name: /^SMS: / })).toHaveCount(6); // no switch for POS receipt / OTP

  const rules = panel(page, 'Sending rules');
  await expect(rules).toContainText('Quiet hours');
  await expect(rules).toContainText('9 PM – 9 AM');
  await expect(rules).toContainText('Storeplix (default)');
  await expect(rules.getByRole('combobox', { name: 'Low-credit alert' })).toBeEnabled();

  const ov = await overview(shop.s);
  const cr = panel(page, 'SMS credits');
  await expect(cr).toContainText('Plan allowance');
  await expect(cr).toContainText(`${ov.allowance.transactional.remaining.toLocaleString('en-US')} of ${ov.allowance.transactional.limit.toLocaleString('en-US')}`);
  await expect(cr).toContainText('Used after the allowance · never expire');
  await expect(cr.getByRole('radiogroup', { name: 'Credit pack' }).getByRole('radio')).toHaveCount(3);
  await expect(cr.getByRole('button', { name: /^Buy 5,000 credits with bKash$/ })).toBeVisible();
  const month = panel(page, 'This month');
  for (const k of ['Messages sent', 'Sent successfully', 'Credits used', 'OTP sent']) await expect(month).toContainText(k);
  expect(apiErrors, apiErrors.join('\n')).toEqual([]);
});

test('overview: language segmented and an event switch write the store settings', async ({ page, context }) => {
  await signInDashboard(context, shop.s);
  await openSms(page);
  const auto = panel(page, 'Automatic messages');
  const before = (await overview(shop.s)).language as string;
  const next = before === 'bn' ? 'English' : 'বাংলা';
  await auto.getByRole('tablist', { name: 'SMS language' }).getByRole('tab', { name: next }).click();
  await expect.poll(async () => (await overview(shop.s)).language).toBe(before === 'bn' ? 'en' : 'bn');
  const sw = auto.getByRole('switch', { name: 'SMS: Shipped' });
  const was = await sw.isChecked();
  await sw.click();
  await expect(sw).toBeChecked({ checked: !was });
  await sw.click(); // restore
  await expect(sw).toBeChecked({ checked: was });
});

test('send test SMS: unverified phone → verify first; verified → sent, logged, charged from the allowance', async ({ page, context }) => {
  test.setTimeout(120_000);
  // Unverified (fresh registration): API 422 phone_not_verified, dialog explains and disables Send.
  const r = await testSmsRaw(shop.s, 'en');
  expect([r.status, r.json.error?.code]).toEqual([422, 'phone_not_verified']);
  await signInDashboard(context, shop.s);
  await openSms(page);
  await page.getByRole('region', { name: 'SMS', exact: true }).getByRole('button', { name: 'Send test SMS' }).click();
  let dlg = page.getByRole('dialog', { name: 'Send test SMS' });
  await expect(dlg.getByRole('alert')).toContainText('Verify your phone in your profile first');
  await expect(dlg.getByRole('button', { name: 'Send' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Cancel' }).click();

  const phone = verifyOwnerPhone(shop.s, shop.t.email);
  expect(phone).not.toBe('');
  await page.reload(); // /auth/me now has phone_verified_at
  await expect(page.getByRole('heading', { name: 'SMS', level: 1 })).toBeVisible({ timeout: 20_000 });
  const mark = smsMark();
  await page.getByRole('region', { name: 'SMS', exact: true }).getByRole('button', { name: 'Send test SMS' }).click();
  dlg = page.getByRole('dialog', { name: 'Send test SMS' });
  await expect(dlg).toContainText('We’ll text');
  await dlg.getByRole('group', { name: 'Test SMS language' }).getByRole('button', { name: 'English' }).click();
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/^Test SMS sent to /)).toBeVisible();
  const sent = await waitSms(mark, (m) => m.to === msisdn(phone), 'test SMS in laravel.log');
  expect(sent.text).toMatch(/: This is a test SMS from Store Plix\. Your shop's SMS is working\.$/);
  expect(sent.text.startsWith('QA smsov shop: '), sent.text).toBe(true);
  const rows = await messages(shop.s, 'filter[purpose]=sms_test');
  expect(rows.length).toBe(1);
  expect([rows[0].status, rows[0].charged_from, rows[0].to_masked.includes('*') || rows[0].to_masked.includes('•')]).toEqual(['sent', 'allowance', true]);
  // The header meta now shows "Last SMS …" and This month counts it.
  await page.reload();
  await expect(page.getByRole('region', { name: 'SMS', exact: true })).toContainText('Last SMS');
  await expect(panel(page, 'This month')).toContainText('Messages sent1');
});
