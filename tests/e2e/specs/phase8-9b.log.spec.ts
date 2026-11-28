import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { adminLogin, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { api, type ThrowawayTenant } from '../support/api';
import { watchConsole } from '../support/roles';
import { adminOk, adminSms, ensurePrimary, masked, msisdn, openSmsSettings, section, STAFF_TEST_PHONE, verifiedMerchant } from '../support/platform-sms';

/**
 * PHASE-8-9B §8, §11.6, S226, S230 (super admin): the platform SMS log.
 *  - a real sign-in code (POST /auth/otp/send, purpose login) becomes a platform row (tenant_id null, the shop in
 *    `merchant`): shown masked with "Code hidden" — the code itself is never in the list, the API or the CSV;
 *  - a provider test SMS is listed as a test with its preview;
 *  - search by exact phone, the type chips (group filter), Export CSV: BOM, the §8 columns, masked phones, codes hidden.
 */
test.describe.configure({ mode: 'serial' });

let admin: AdminSession;
let m: ThrowawayTenant;
let devOtp = '';

test.beforeAll(async () => {
  test.setTimeout(150_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-super-p89b');
  await ensurePrimary(admin);
  m = await verifiedMerchant('p89blog');
  const otp = await api(null, 'POST', '/auth/otp/send', { phone: m.phone, purpose: 'login' });
  expect(otp.status, JSON.stringify(otp.json)).toBe(202);
  devOtp = String(otp.json.data?.dev_otp ?? '');
  const p = (await adminOk(admin, 'GET', '/providers', undefined, 200, 'overview')).primary;
  await adminOk(admin, 'POST', `/providers/${p.id}/test`, { phone: STAFF_TEST_PHONE }, 200, 'provider test');
});
test.afterAll(() => m?.cleanup());

test('API: the code row is a platform row, masked, body hidden; never shop rows', async () => {
  const r = await adminSms(admin, 'GET', `/messages?filter[q]=${m.phone}`);
  expect(r.status, r.text).toBe(200);
  const rows = r.json.data as Array<{ to_masked: string; type: string; group: string; body_hidden: boolean; body_preview: string | null; merchant: { id: string } | null }>;
  const code = rows.find((x) => x.type === 'sign_in_code');
  expect(code, r.text).toBeTruthy();
  expect([code!.to_masked, code!.group, code!.body_hidden, code!.body_preview]).toEqual([masked(m.phone), 'security', true, null]);
  // An anonymous sign-in code isn't about a known shop: `merchant` is that shop or null ("the shop, if any", §5).
  expect([m.session.tenantId, undefined]).toContain(code!.merchant?.id);
  expect(r.text).not.toContain(msisdn(m.phone));
  if (devOtp) expect(r.text).not.toContain(devOtp);
  const all = await adminSms(admin, 'GET', '/messages');
  expect((all.json.data as Array<{ type: string }>).every((x) => !['order_placed', 'order_confirmed', 'campaign', 'test_sms'].includes(x.type))).toBe(true);
});

test('UI: search, Code hidden, type chips, masked CSV export', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page, 'log');
  const log = section(page, 'Platform SMS log');
  await expect(log.getByRole('table')).toBeVisible({ timeout: 20_000 });
  await expect(log).toContainText('Store Plix SMS test from'); // provider test row preview
  await log.getByRole('textbox', { name: 'Search phone or shop' }).fill(m.phone);
  const row = log.getByRole('row').filter({ hasText: masked(m.phone) }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('Code hidden');
  if (devOtp) await expect(log).not.toContainText(devOtp);

  await log.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'Promotional' }).click();
  await expect(log.getByText('No messages match these filters')).toBeVisible({ timeout: 15_000 });
  await log.getByRole('group', { name: 'Type' }).getByRole('button', { name: 'Login & security' }).click();
  await expect(row).toBeVisible();

  const download = page.waitForEvent('download');
  await log.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^platform-sms-.*\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8');
  expect(csv.charCodeAt(0), 'UTF-8 BOM').toBe(0xfeff);
  const [header, ...lines] = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
  expect(header!.toLowerCase()).toMatch(/time.*phone.*merchant.*type.*group.*message.*parts.*status.*provider.*error/);
  const line = lines.find((l) => l.includes(masked(m.phone)));
  expect(line, csv.slice(0, 800)).toBeTruthy();
  expect(line).toContain('Code hidden');
  expect(csv).not.toContain(msisdn(m.phone));
  expect(csv).not.toContain(m.phone);
  if (devOtp) expect(csv).not.toContain(devOtp);
  await expect(page.getByText('CSV downloaded · phones masked, codes hidden')).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
