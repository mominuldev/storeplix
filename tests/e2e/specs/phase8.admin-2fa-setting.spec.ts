import { expect, test, type Page } from '@playwright/test';
import {
  SUPER_ADMIN,
  adminApi,
  adminLogin,
  adminPasswordStep,
  adminUrl,
  clearStoredSecuritySetting,
  getSecuritySetting,
  nextTotp,
  patchSecuritySetting,
  reseedSuperAdmin,
  signInAdminApp,
  type AdminSession,
  type SecuritySetting,
} from '../support/admin';
import { STAFF, seedStaff } from '../support/analytics';

/**
 * PHASE-8-1-AMENDMENT-ADMIN-2FA (A1, Q231) §2 QA `phase8.admin-2fa-setting`: the platform setting
 * `staff_two_factor_required`.
 *  1. Setting off (through the API) → the seeded super admin signs in with the password alone and lands in the app.
 *  2. The super admin turns it on in Platform settings → Security, confirming with the current password → the next
 *     sign-in asks for the authentication code.
 *  3. A Support staff member has no Platform settings item and GET/PATCH /admin/settings/security answer 403.
 *
 * The e2e API runs with ADMIN_TWO_FACTOR_REQUIRED=true (A1-7), so the stored value is what this file changes. The value
 * found before the run is restored afterwards (stored → PATCH it back; nothing stored → the row is removed).
 */
test.describe.configure({ mode: 'serial' });

let before: SecuritySetting;

test.beforeAll(async () => {
  reseedSuperAdmin();
  const admin = await adminLogin('admin-2fa-setting-setup');
  before = await getSecuritySetting(admin);
});

test.afterAll(async () => {
  if (!before) return;
  if (before.source === 'default') clearStoredSecuritySetting();
  else {
    reseedSuperAdmin();
    const admin = await adminLogin('admin-2fa-setting-restore');
    const r = await patchSecuritySetting(admin, before.staff_two_factor_required);
    expect(r.status, r.text).toBe(200);
  }
  reseedSuperAdmin();
});

async function fillPassword(page: Page) {
  await page.goto(`${adminUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Sign in to Platform admin' })).toBeVisible();
  await page.getByLabel('Work email').fill(SUPER_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(SUPER_ADMIN.password);
  await page.getByRole('button', { name: 'Continue' }).click();
}

const overview = (page: Page) => page.getByRole('heading', { name: 'Platform overview' });
const settingsNav = (page: Page) => page.getByRole('link', { name: 'Platform settings' });

test('API: the setting has the A1-4 shape; a wrong password is 422 invalid_password and changes nothing', async () => {
  const admin = await adminLogin('admin-2fa-setting');
  const s = await getSecuritySetting(admin);
  expect(typeof s.staff_two_factor_required).toBe('boolean');
  expect(s.environment_default).toBe(true); // ADMIN_TWO_FACTOR_REQUIRED=true on the e2e API (A1-7)
  expect(['setting', 'default']).toContain(s.source);

  const bad = await patchSecuritySetting(admin, !s.staff_two_factor_required, 'not-the-password');
  expect(bad.status, bad.text).toBe(422);
  expect(bad.json.error.code).toBe('invalid_password');
  expect((await getSecuritySetting(admin)).staff_two_factor_required).toBe(s.staff_two_factor_required);

  const missing = await adminApi(admin, 'PATCH', '/admin/settings/security', { staff_two_factor_required: false });
  expect(missing.status, missing.text).toBe(422);
});

test('setting off (API) → password-only sign-in lands in the app; me says two-step is off', async ({ page }) => {
  reseedSuperAdmin();
  const admin = await adminLogin('admin-2fa-setting');
  const off = await patchSecuritySetting(admin, false);
  expect(off.status, off.text).toBe(200);
  expect(off.json.data.staff_two_factor_required).toBe(false);
  expect(off.json.data.source).toBe('setting');
  expect(off.json.data.updated_by?.id).toBe(admin.user.id);

  // Audited admin.settings_updated {key, from, to} (A1-4).
  const audit = await adminApi(admin, 'GET', '/admin/audit-logs?per_page=50');
  expect(audit.status, audit.text).toBe(200);
  const row = (audit.json.data as { action: string; meta?: Record<string, unknown> }[]).find((e) => e.action === 'admin.settings_updated');
  expect(row, audit.text).toBeTruthy();

  // API: the password step signs in at once (no login_token), the cookie jar is a session (A1-3).
  const pw = await adminPasswordStep(SUPER_ADMIN.email, SUPER_ADMIN.password);
  try {
    expect(pw.status, JSON.stringify(pw.json)).toBe(200);
    expect(pw.json.data.step).toBe('signed_in');
    expect(pw.json.data.login_token).toBeUndefined();
    expect(pw.json.data.user.email).toBe(SUPER_ADMIN.email);
    const me = await pw.ctx.get('/api/v1/admin/auth/me', { failOnStatusCode: false });
    expect(me.status()).toBe(200);
    const meJson = (await me.json()) as { data: { security: { staff_two_factor_required: boolean }; environment: string } };
    expect(meJson.data.security.staff_two_factor_required).toBe(false);
    expect(typeof meJson.data.environment).toBe('string');
  } finally {
    await pw.ctx.dispose();
  }

  // UI: password → straight to the dashboard, never the TOTP step; survives a reload.
  reseedSuperAdmin(); // admin-login throttle (5/email/IP per minute)
  await fillPassword(page);
  await expect(overview(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toHaveCount(0);
  await page.reload();
  await expect(overview(page)).toBeVisible();
});

test('super admin turns it on in Platform settings → Security (password confirm) → next sign-in asks for the code', async ({ page, browser }) => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  const admin = await adminLogin('admin-2fa-setting', SUPER_ADMIN, 'signed_in'); // still off from the previous test
  expect((await getSecuritySetting(admin)).staff_two_factor_required).toBe(false);

  await signInAdminApp(page.context(), admin);
  await page.goto(`${adminUrl}/`);
  await expect(overview(page)).toBeVisible({ timeout: 15_000 });
  await settingsNav(page).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole('heading', { name: 'Platform settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByText('Security')).toBeVisible();

  const toggle = page.getByRole('switch', { name: 'Require two-step sign-in for platform staff' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Default for this environment', { exact: false })).toContainText('On'); // ADMIN_TWO_FACTOR_REQUIRED=true
  await expect(page.getByText('Set by a super admin')).toBeVisible();
  await toggle.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Turn on two-step sign-in?')).toBeVisible();
  const password = dialog.getByLabel('Your current password');
  // Wrong password first: the dialog stays open with the field error and nothing is stored.
  await password.fill('not-the-password');
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(dialog.getByText('That password isn’t right. Try again.').or(dialog.getByRole('alert'))).toBeVisible();
  await expect(dialog).toBeVisible();
  expect((await getSecuritySetting(admin)).staff_two_factor_required).toBe(false);

  await password.fill(SUPER_ADMIN.password);
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Two-step sign-in is on for platform staff.')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/Last changed by /)).toBeVisible();
  await expect.poll(async () => (await getSecuritySetting(admin)).staff_two_factor_required).toBe(true);
  const s = await getSecuritySetting(admin);
  expect(s.source).toBe('setting');
  expect(s.updated_by?.id).toBe(admin.user.id);

  // Next sign-in (fresh browser context) asks for the code; the code completes it.
  reseedSuperAdmin();
  const fresh = await browser.newContext();
  try {
    const p2 = await fresh.newPage();
    await fillPassword(p2);
    await expect(p2.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
    await p2.getByLabel('Authentication code digit 1').click();
    await p2.keyboard.type(await nextTotp(SUPER_ADMIN.totpSecret));
    await p2.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(overview(p2)).toBeVisible({ timeout: 15_000 });
  } finally {
    await fresh.close();
  }

  // API agrees: password alone is only the first step again.
  const pw = await adminPasswordStep(SUPER_ADMIN.email, SUPER_ADMIN.password);
  try {
    expect(pw.status).toBe(200);
    expect(pw.json.data.step).toBe('totp');
    expect((await pw.ctx.get('/api/v1/admin/auth/me', { failOnStatusCode: false })).status()).toBe(401);
  } finally {
    await pw.ctx.dispose();
  }
});

test('Support: no Platform settings item; GET/PATCH /admin/settings/security → 403', async ({ page }) => {
  test.setTimeout(90_000);
  seedStaff(STAFF.support);
  const support: AdminSession = await adminLogin('admin-2fa-setting-support', STAFF.support);
  expect(support.user.permissions).not.toContain('manage_settings');

  const get = await adminApi(support, 'GET', '/admin/settings/security');
  expect(get.status, get.text).toBe(403);
  expect(get.json.error.code).toBe('forbidden');
  const patch = await adminApi(support, 'PATCH', '/admin/settings/security', { staff_two_factor_required: false, current_password: STAFF.support.password });
  expect(patch.status, patch.text).toBe(403);

  await signInAdminApp(page.context(), support);
  await page.goto(`${adminUrl}/`);
  await expect(overview(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Merchants', exact: true })).toBeVisible();
  await expect(settingsNav(page)).toHaveCount(0);
  // Deep link: no switch is ever offered.
  await page.goto(`${adminUrl}/settings`);
  await expect(page.getByText('You can’t open platform settings')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Require two-step sign-in for platform staff' })).toHaveCount(0);
});
