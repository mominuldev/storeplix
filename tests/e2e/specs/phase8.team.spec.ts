import { expect, test } from '@playwright/test';
import { createTenant, deleteE2eUser, findMailLink, mailMark, tinker, unique, type ThrowawayTenant } from '../support/api';
import { adminApi, adminLogin, adminUrl, findTenant, reseedSuperAdmin, totp, type AdminSession } from '../support/admin';

/**
 * PHASE-8-1-CONTRACT §10 QA `phase8.team` (P8-16, S79): a super admin invites a Billing staff member → they accept
 * through the mailed link and enrol TOTP (setup key, code, recovery codes) → signed in as Billing, Suspend is hidden on
 * a merchant and the API answers 403 for it, while billing actions stay available.
 */
test.describe.configure({ mode: 'serial' });

const email = `${unique('qa-staff-')}@e2e.storeplix.test`;
const password = 'E2eStaff12345!';
let admin: AdminSession;
let shop: ThrowawayTenant;
let tenantId: string;
let secret = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-team');
  shop = await createTenant('p8t');
  tenantId = (await findTenant(admin, shop.email)).id as string;
});

test.afterAll(() => {
  shop?.cleanup();
  // test-only cleanup: platform invitations keep the accepted user's id, remove them before the user.
  tinker(`Illuminate\\Support\\Facades\\DB::table('platform_invitations')->where('email','${email}')->delete(); echo 'ok';`);
  deleteE2eUser(email);
});

test('invite → accept through the mailed link → enrol 2FA → dashboard', async ({ page }) => {
  const mark = mailMark();
  const invite = await adminApi(admin, 'POST', '/admin/team/invitations', { email, role: 'billing' });
  expect(invite.status, invite.text).toBe(201);
  const dup = await adminApi(admin, 'POST', '/admin/team/invitations', { email, role: 'billing' });
  expect(dup.status).toBe(422);

  const link = await findMailLink(email, '/accept-invite#token=', mark);
  await page.goto(link.replace(/^https?:\/\/[^/]+/, adminUrl));
  await expect(page.getByRole('heading', { name: 'Join Platform admin' })).toBeVisible();
  await page.getByLabel('Full name').fill('QA Billing Staff');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Continue to 2FA setup' }).click();

  // Enrolment: read the setup key ("ABCD EFGH …"), compute the current code.
  const key = page.getByText(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/).first();
  await expect(key).toBeVisible({ timeout: 15_000 });
  secret = (await key.innerText()).replace(/\s+/g, '');
  await page.getByLabel('Authentication code digit 1').click();
  await page.keyboard.type(totp(secret));
  await page.getByRole('button', { name: 'Turn on 2FA and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  await page.getByLabel('I saved them somewhere safe').check();
  await page.getByRole('button', { name: 'Continue to Platform admin' }).click();
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible({ timeout: 15_000 });

  const team = await adminApi(admin, 'GET', `/admin/team?filter[q]=${encodeURIComponent(email)}`);
  expect(team.status, team.text).toBe(200);
  expect(JSON.stringify(team.json.data)).toContain(email);
});

test('as Billing: Suspend is hidden on a merchant and refused by the API; billing actions stay', async ({ page }) => {
  // Sign in through the UI with the enrolled secret (the enrolment step can't be replayed: next 30 s step).
  await page.goto(`${adminUrl}/login`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
  const step = Math.floor(Date.now() / 30_000);
  // The enrolment consumed the current step; wait for the next one.
  await page.waitForTimeout(Math.max(0, (step + 1) * 30_000 - Date.now() + 500));
  await page.getByLabel('Authentication code digit 1').click();
  await page.keyboard.type(totp(secret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible({ timeout: 15_000 });

  await page.goto(`${adminUrl}/merchants/${tenantId}`);
  await expect(page.getByRole('heading', { name: 'QA p8t', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change plan' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Impersonate', exact: true })).toHaveCount(0);

  // The API refuses it on the same session (cookies of this page).
  const suspend = await page.evaluate(async (id) => {
    const xsrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1] ?? '');
    const r = await fetch(`/api/v1/admin/tenants/${id}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': xsrf },
      body: JSON.stringify({ reason_code: 'other', reason: 'QA e2e billing role check' }),
    });
    return { status: r.status, body: await r.json() };
  }, tenantId);
  expect(suspend.status).toBe(403);
  expect(suspend.body.error.code).toBe('forbidden');
});

test('the super admin sees the join on the platform audit log', async () => {
  const r = await adminApi(admin, 'GET', '/admin/audit-logs?per_page=50');
  expect(r.status, r.text).toBe(200);
  const actions = (r.json.data as { action: string }[]).map((e) => e.action);
  expect(actions).toEqual(expect.arrayContaining(['admin.staff_invited', 'admin.staff_joined']));
});
