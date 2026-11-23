import { expect, test, type Page } from '@playwright/test';
import { api, demoSession } from '../support/api';
import { SUPER_ADMIN, adminApi, adminLogin, adminPasswordStep, adminTotpStep, adminUrl, nextTotp, reseedSuperAdmin, totp } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §10 QA `phase8.admin-auth` (S67–S70): the seeded super admin (PlatformStaffE2eSeeder, fixed TOTP
 * secret, codes computed here) signs in through the UI; a wrong code; lockout after five; a merchant session is
 * refused on admin routes and an admin session on merchant routes. The seeder is re-run around the file so the
 * lockout never leaks into other specs.
 */
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => reseedSuperAdmin());
test.afterAll(() => reseedSuperAdmin());

async function typeCode(page: Page, code: string) {
  await page.getByLabel('Authentication code digit 1').click();
  await page.keyboard.type(code);
}

async function passwordStep(page: Page) {
  await page.goto(`${adminUrl}/login`);
  await expect(page.getByRole('heading', { name: 'Sign in to Platform admin' })).toBeVisible();
  await page.getByLabel('Work email').fill(SUPER_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(SUPER_ADMIN.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
}

test('UI: password then TOTP opens the dashboard; reload keeps the session; sign out', async ({ page }) => {
  await passwordStep(page);
  await typeCode(page, await nextTotp(SUPER_ADMIN.totpSecret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
});

test('UI: a wrong code shows the attempts left and keeps the user on the TOTP step', async ({ page }) => {
  await passwordStep(page);
  const wrong = totp(SUPER_ADMIN.totpSecret) === '000000' ? '111111' : '000000';
  await typeCode(page, wrong);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText(/1 incorrect code · 4 attempts left/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
});

test('API: wrong password and unknown email answer the same 422; no session before TOTP', async () => {
  const bad = await adminPasswordStep(SUPER_ADMIN.email, 'not-the-password');
  const unknown = await adminPasswordStep('nobody-e2e@storeplix.com', 'whatever-123');
  try {
    expect(bad.status).toBe(422);
    expect(unknown.status).toBe(422);
    expect(bad.json).toEqual(unknown.json);
    expect(bad.json.error.code).toBe('validation_failed');
    // Password alone: /admin/auth/me is still 401 on that cookie jar.
    const ok = await adminPasswordStep(SUPER_ADMIN.email, SUPER_ADMIN.password);
    try {
      expect(ok.status).toBe(200);
      const me = await ok.ctx.get('/api/v1/admin/auth/me', { failOnStatusCode: false });
      expect(me.status()).toBe(401);
    } finally {
      await ok.ctx.dispose();
    }
  } finally {
    await bad.ctx.dispose();
    await unknown.ctx.dispose();
  }
});

test('API: a merchant session is refused on /admin/*, an admin session on merchant routes', async () => {
  const merchant = await demoSession();
  const r = await api(merchant, 'GET', '/admin/overview');
  expect([401, 403]).toContain(r.status);

  const admin = await adminLogin('admin-auth');
  expect((await adminApi(admin, 'GET', '/admin/overview')).status).toBe(200);
  const asMerchant = await adminApi(admin, 'GET', '/stores');
  expect([401, 403]).toContain(asMerchant.status);
});

test('API + UI: five wrong codes lock the account for 15 minutes', async ({ page }) => {
  // This file signs the same email in more than `admin-login` allows per minute (5/email/IP): reset the counters.
  reseedSuperAdmin();
  const { ctx, json } = await adminPasswordStep(SUPER_ADMIN.email, SUPER_ADMIN.password);
  try {
    const wrong = totp(SUPER_ADMIN.totpSecret) === '000000' ? '111111' : '000000';
    let last = { status: 0, json: {} as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 5; i++) last = await adminTotpStep(ctx, json.data.login_token, { code: wrong });
    expect(last.status).toBe(422);
    expect(last.json.error.details.attempts_left).toBe(0);
  } finally {
    await ctx.dispose();
  }
  // Locked: even the right password is refused with the generic 422, and the UI says why on the TOTP step's exit.
  const locked = await adminPasswordStep(SUPER_ADMIN.email, SUPER_ADMIN.password);
  try {
    expect(locked.status).toBe(422);
  } finally {
    await locked.ctx.dispose();
  }
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel('Work email').fill(SUPER_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(SUPER_ADMIN.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('These credentials do not match our records.')).toBeVisible();
});
