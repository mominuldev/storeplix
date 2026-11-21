import { expect, test } from '@playwright/test';
import { api, deleteE2eUser, demoSession, findMailLink, mailMark, unique, urls, type Session } from '../support/api';

/**
 * Deferred from Phase 2 (docs/reviews/phase-2-qa.md §6):
 *  - invite → accept: the owner invites a throwaway address, the invitee opens the mailed link and
 *    creates an account; they land in the demo shop as staff.
 *  - password reset: the same user requests a reset, opens the mailed link, sets a new password and
 *    can sign in with it (the old one is rejected).
 * Mail: local MAIL_MAILER=log → the link is read from apps/api/storage/logs/laravel.log
 * (or from Mailpit when MAILPIT_URL is set). Cleanup: membership removed, user deleted (artisan tinker).
 *
 * Auth endpoints share `throttle:auth` (10/min per IP): this file uses 3 of them.
 */
test.describe.configure({ mode: 'serial' });

let owner: Session;
const email = `${unique('invitee')}@e2e.storeplix.test`;
const firstPassword = 'E2eFirst12345';
const newPassword = 'E2eSecond67890';

test.beforeAll(async () => {
  owner = await demoSession();
});

test.afterAll(async () => {
  const staff = await api(owner, 'GET', '/staff');
  for (const m of (staff.json.data ?? []) as Array<{ id: string; email: string; kind: string }>) {
    if (m.email !== email) continue;
    await api(owner, 'DELETE', m.kind === 'invitation' ? `/staff/invitations/${m.id}` : `/staff/${m.id}`);
  }
  deleteE2eUser(email);
});

test('invite → accept: the invitee joins the shop as staff', async ({ page }) => {
  const mark = mailMark();
  const invite = await api(owner, 'POST', '/staff/invitations', { email, role: 'staff', name: 'E2E Invitee' });
  expect(invite.status, JSON.stringify(invite.json)).toBe(201);

  const link = await findMailLink(email, '/invite?token=', mark);
  expect(link.startsWith(`${urls.merchant}/invite?token=`)).toBe(true);

  await page.goto(link);
  await page.getByLabel('Your name').fill('E2E Invitee');
  // The form requires a BD mobile (the API treats it as optional); use a random unused 019 number.
  await page.getByLabel('Mobile number').fill(`019${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
  await page.getByLabel('Password', { exact: true }).fill(firstPassword);
  await page.getByLabel('Confirm password').fill(firstPassword);
  await page.getByRole('button', { name: 'Create account & join' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/invite'), { timeout: 15_000 });

  const staff = await api(owner, 'GET', '/staff');
  const member = (staff.json.data as Array<{ email: string; kind: string; role: string; status: string }>).find((m) => m.email === email);
  expect(member).toMatchObject({ role: 'staff' });
  expect(member?.kind).not.toBe('invitation');
  // The link is single-use.
  const token = new URL(link).searchParams.get('token')!;
  expect((await api(null, 'GET', `/invitations/${encodeURIComponent(token)}`)).status).toBe(404);
});

test('password reset via the mailed link, then sign in with the new password', async ({ page }) => {
  const mark = mailMark();
  await page.goto(`${urls.merchant}/forgot-password`);
  await page.getByRole('tab', { name: 'Email link' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();

  const link = await findMailLink(email, '/reset-password?token=', mark);
  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByText(/password (was |has been )?(changed|updated|saved|reset)/i).first()).toBeVisible({ timeout: 10_000 });

  // Old password rejected, new one accepted (UI sign-in).
  expect((await api(null, 'POST', '/auth/login', { email, password: firstPassword })).status).not.toBe(200);
  await page.goto(`${urls.merchant}/login`);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.locator('input[type="password"]').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });
});
