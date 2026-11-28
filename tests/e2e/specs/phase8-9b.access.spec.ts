import { expect, test } from '@playwright/test';
import { adminApi, adminLogin, adminUrl, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { api, apiCall, createTenant, type ThrowawayTenant } from '../support/api';
import { seedStaff, STAFF } from '../support/analytics';
import { resetPlatformSms, reveInput } from '../support/platform-sms';

/**
 * PHASE-8-9B §2, §9.1, P89B-25, S221 (access): every `/admin/sms/*` route needs `manage_settings` (super admin).
 *  - support and read-only staff get 403 `forbidden` on reads and writes; the SMS provider page shows the
 *    "You can't open platform settings" card, the nav item and the shell banner are hidden;
 *  - a merchant session can't reach the admin surface; anonymous → 401;
 *  - the super admin sees the shell banner (`no_provider`, danger) with "Open SMS provider" on other pages;
 *  - `/account/sms-preferences` needs a signed-in merchant (anonymous 401); the public opt-out lookup 404s a bad code.
 */
test.describe.configure({ mode: 'serial' });

let superAdmin: AdminSession;
let support: AdminSession;
let readOnly: AdminSession;
let merchant: ThrowawayTenant;

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/admin/sms/drivers'],
  ['GET', '/admin/sms/alerts'],
  ['GET', '/admin/sms/providers'],
  ['POST', '/admin/sms/providers', reveInput('QA Forbidden')],
  ['GET', '/admin/sms/message-types'],
  ['PATCH', '/admin/sms/message-types/welcome', { enabled: false }],
  ['GET', '/admin/sms/broadcasts'],
  ['GET', '/admin/sms/broadcasts/audiences'],
  ['POST', '/admin/sms/broadcasts/estimate', { audience: { kind: 'all' }, body_bn: 'x {link}', body_en: 'x {link}' }],
  ['GET', '/admin/sms/messages'],
  ['GET', '/admin/sms/messages/export'],
];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  reseedSuperAdmin();
  resetPlatformSms();
  seedStaff(STAFF.support);
  seedStaff(STAFF.readOnly);
  superAdmin = await adminLogin('admin-super-p89b');
  support = await adminLogin('admin-support-p89b', STAFF.support);
  readOnly = await adminLogin('admin-readonly-p89b', STAFF.readOnly);
  merchant = await createTenant('p89bacc');
});
test.afterAll(() => merchant?.cleanup());

test('support and read-only staff: 403 forbidden on every platform SMS route', async () => {
  for (const who of [support, readOnly]) {
    for (const [method, path, body] of ROUTES) {
      const r = await adminApi(who, method, path, body);
      expect([r.status, r.json.error?.code], `${who.user.email} ${method} ${path}: ${r.text.slice(0, 200)}`).toEqual([403, 'forbidden']);
    }
  }
  // Nothing was created by the refused POST.
  const o = await adminApi(superAdmin, 'GET', '/admin/sms/providers');
  expect([o.status, o.json.data?.source]).toEqual([200, 'none']);
});

test('merchant session and anonymous calls never reach the admin surface', async () => {
  for (const [method, path, body] of ROUTES.slice(0, 4)) {
    const m = await apiCall(merchant.session, method, path, body === undefined ? {} : { json: body });
    expect([401, 403], `merchant ${method} ${path}: ${m.status} ${m.text.slice(0, 200)}`).toContain(m.status);
    const anon = await apiCall(null, method, path, body === undefined ? {} : { json: body });
    expect([401, 403], `anonymous ${method} ${path}: ${anon.status}`).toContain(anon.status);
  }
  expect((await api(null, 'GET', '/account/sms-preferences')).status).toBe(401);
  expect((await api(merchant.session, 'GET', '/account/sms-preferences')).status).toBe(200);
  const lookup = await api(null, 'GET', '/platform-sms/opt-out/AAAAAAAAAA');
  expect([lookup.status, lookup.json.error?.code]).toEqual([404, 'not_found']);
});

test('UI: support sees the lock card and no banner; the super admin sees the no-provider banner', async ({ browser }) => {
  const ctxS = await browser.newContext();
  const pageS = await ctxS.newPage();
  await signInAdminApp(ctxS, support);
  await pageS.goto(`${adminUrl}/settings/sms`);
  await expect(pageS.getByText('You can’t open platform settings')).toBeVisible({ timeout: 20_000 });
  await expect(pageS.getByRole('tablist', { name: 'SMS provider sections' })).toHaveCount(0);
  await pageS.goto(`${adminUrl}/`);
  await expect(pageS.getByRole('navigation').first()).toBeVisible({ timeout: 20_000 });
  await expect(pageS.getByTestId('platform-sms-banner')).toHaveCount(0);
  await ctxS.close();

  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await signInAdminApp(ctxA, superAdmin);
  await pageA.goto(`${adminUrl}/`);
  const banner = pageA.getByTestId('platform-sms-banner');
  await expect(banner).toContainText('No SMS provider — sign-in codes will fail', { timeout: 20_000 });
  await expect(banner).toHaveAttribute('role', 'alert');
  await banner.getByRole('link', { name: 'Open SMS provider' }).click();
  await expect(pageA).toHaveURL(/\/settings\/sms\?tab=provider/);
  await expect(pageA.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'SMS provider' })).toBeVisible();
  await expect(pageA.getByTestId('platform-sms-banner').getByRole('link', { name: 'Open SMS provider' })).toHaveCount(0);
  await ctxA.close();
});
