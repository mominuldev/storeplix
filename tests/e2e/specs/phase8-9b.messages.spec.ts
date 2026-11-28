import { expect, test } from '@playwright/test';
import { adminLogin, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { watchConsole } from '../support/roles';
import { smsMark } from '../support/sms';
import { adminOk, adminSms, ensurePrimary, msisdn, openSmsSettings, resetPlatformSms, STAFF_TEST_PHONE, waitSent } from '../support/platform-sms';

/**
 * PHASE-8-9B §6, §11.4, S226, S227 (super admin): message types tab.
 *  - KPI strip + four group cards; locked rows (codes) show "Always on" and open read-only (no Save) and the API
 *    refuses edits and switches on them (422 `platform_sms_type_locked`);
 *  - a switch turns a billing type off (API `enabled: false`) and back on;
 *  - the `invoice_issued` bn template: a typed link is refused (Save disabled), a valid custom text saves ("Edited"),
 *    "Send test to me" sends the rendered sample through the gateway (log driver), Reset restores the default.
 */
test.describe.configure({ mode: 'serial' });

let admin: AdminSession;
const CUSTOM_BN = 'Store Plix: {store_name}-এর ইনভয়েস {invoice_no}, {amount} টাকা, শেষ তারিখ {due_date}। এখনই পরিশোধ করুন: {link}';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  resetPlatformSms();
  admin = await adminLogin('admin-super-p89b');
  await ensurePrimary(admin);
});

const row = (page: import('@playwright/test').Page, type: string) => page.getByTestId(`type-${type}`);

test('catalogue: groups, KPIs, locked rows read-only and refused by the API', async ({ page, context }) => {
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page, 'messages');
  for (const title of ['Registration', 'Invoice & billing', 'Login & security', 'Promotional']) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  for (const kpi of ['Sent this month', 'Sign-in codes', 'Promotional', 'Cost this month']) await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
  // Not built (Q278): no such rows.
  for (const hidden of ['New sign-in alert', 'Trial ending offer', 'Win-back', '2-step code']) await expect(page.getByText(hidden)).toHaveCount(0);

  for (const locked of ['sign_in_code', 'password_reset_code', 'phone_verification']) {
    await expect(row(page, locked)).toContainText('Always on');
    await expect(row(page, locked).getByRole('switch')).toHaveCount(0);
  }
  await row(page, 'sign_in_code').getByRole('button', { name: 'View', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /^Template/ });
  await expect(drawer).toContainText('Locked: always on, the text can’t be changed.');
  await expect(drawer.locator('#platform-sms-template-body')).toHaveAttribute('readonly', '');
  await expect(drawer.locator('#platform-sms-template-body')).toHaveValue('Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.');
  await expect(drawer.getByRole('button', { name: 'Save template' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).last().click();

  let r = await adminSms(admin, 'PUT', '/message-types/sign_in_code/templates/en', { body: 'Code {otp}', revision: 0 });
  expect([r.status, r.json.error?.code]).toEqual([422, 'platform_sms_type_locked']);
  r = await adminSms(admin, 'PATCH', '/message-types/password_reset_code', { enabled: false });
  expect([r.status, r.json.error?.code]).toEqual([422, 'platform_sms_type_locked']);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('switch a billing type off and on', async ({ page, context }) => {
  await signInAdminApp(context, admin);
  await openSmsSettings(page, 'messages');
  const sw = row(page, 'payment_received').getByRole('switch', { name: 'Payment received SMS' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(page.getByText('Payment received SMS off')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  const list = (await adminOk(admin, 'GET', '/message-types', undefined, 200, 'types')) as unknown as Array<{ type: string; enabled: boolean | null }>;
  expect(list.find((t) => t.type === 'payment_received')?.enabled).toBe(false);
  await sw.click();
  await expect(page.getByText('Payment received SMS on')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
});

test('edit the invoice_issued bn template: link refused, save, test send, reset', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page, 'messages');
  await row(page, 'invoice_issued').getByRole('button', { name: 'Edit', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /^Edit template/ });
  await expect(drawer).toContainText('Invoice issued · sent when a renewal invoice is issued');
  const body = drawer.locator('#platform-sms-template-body');
  const save = drawer.getByRole('button', { name: 'Save template' });

  await body.fill('Store Plix: ইনভয়েস {invoice_no} পরিশোধ করুন https://pay.example.com {link}');
  await expect(drawer.getByRole('alert').first()).toBeVisible();
  await expect(save).toBeDisabled();
  await body.fill('Store Plix: ইনভয়েস পরিশোধ করুন {link}'); // required {invoice_no} missing
  await expect(save).toBeDisabled();

  await body.fill(CUSTOM_BN);
  await expect(drawer.getByText('Unsaved')).toBeVisible();
  await expect(drawer.getByTestId('template-preview')).toContainText('SP-2026-001042', { timeout: 15_000 });
  await save.click();
  await expect(page.getByText('Template saved', { exact: true })).toBeVisible();
  const types = (await adminOk(admin, 'GET', '/message-types', undefined, 200, 'types')) as unknown as Array<{ type: string; templates: Array<{ language: string; body: string; is_custom: boolean }> }>;
  const bn = types.find((t) => t.type === 'invoice_issued')!.templates.find((t) => t.language === 'bn')!;
  expect([bn.is_custom, bn.body]).toEqual([true, CUSTOM_BN]);
  await expect(row(page, 'invoice_issued')).toContainText('Edited');

  // Send test to me (the drawer stays open after saving): the rendered sample goes out through the gateway (log driver).
  await expect(drawer.getByText('Edited', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Send test to me' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send “Invoice issued” to me' });
  await dlg.getByLabel('Send a test SMS to').fill(STAFF_TEST_PHONE);
  const mark = smsMark();
  await dlg.getByRole('button', { name: 'Send test' }).click();
  await expect(dlg.getByRole('status')).toContainText(/Test (sent|queued) to 01711-•••211/, { timeout: 20_000 });
  const sms = await waitSent(mark, (m) => m.to === msisdn(STAFF_TEST_PHONE) && m.text.includes('SP-2026-001042'), 'invoice_issued test SMS');
  expect(sms.text).toContain('Mugdho Fashion');
  expect(sms.text).toContain('এখনই পরিশোধ করুন');
  // SMS_DRIVER=log wins for sending (P89B-2): no carrying provider, so no sender ID — but the billing route is used.
  expect((sms as unknown as { route?: string }).route).toBe('billing');
  await dlg.getByRole('button', { name: 'Close' }).last().click();

  // Reset to default (confirm) → the row loses "Edited".
  await drawer.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('dialog', { name: 'Reset to the default text?' }).getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Template reset to the default text')).toBeVisible();
  await expect(row(page, 'invoice_issued')).not.toContainText('Edited');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
