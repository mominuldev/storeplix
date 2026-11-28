import { expect, test } from '@playwright/test';
import { adminLogin, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { api, signInDashboard, urls, type ThrowawayTenant } from '../support/api';
import { watchConsole } from '../support/roles';
import { sentSince, smsMark } from '../support/sms';
import {
  adminOk,
  adminSms,
  ensurePrimary,
  masked,
  msisdn,
  openSmsSettings,
  optOutCode,
  optOutState,
  resetPlatformSms,
  section,
  verifiedMerchant,
  waitSent,
} from '../support/platform-sms';

/**
 * PHASE-8-9B §7, §11.5, §12, S228, S229 (super admin + merchant app):
 *  - a broadcast to the Growth plan: both texts, audience chip, Send now, live estimate; the confirm dialog needs the
 *    acknowledgement AND the typed recipient count of a fresh estimate → every recipient gets the bn text + the server
 *    STOP footer with a personal `/s/{code}` link (log driver); recipients drawer lists them masked;
 *  - the opt-out page `/s/{code}` in the merchant app: GET shows the masked phone and changes nothing, "Stop offers"
 *    opts out (source `link`), reload shows "already"; bad code → "This link is not valid"; `/s/test` → test message;
 *  - a second broadcast skips the opted-out owner (estimate + nothing sent to them); a stale typed count → 409
 *    `broadcast_estimate_changed`; the weekly cap of 2 then skips the other owner;
 *  - Account → "Store Plix SMS": the switch shows the state and turns offers back on (source `account` when off).
 * Runs inside 09:00–21:00 Asia/Dhaka only ("Send now" is refused outside, P89B-18).
 */
test.describe.configure({ mode: 'serial' });

let admin: AdminSession;
let a: ThrowawayTenant;
let b: ThrowawayTenant;
let codeA = '';
const NAME = `QA Offer ${Date.now().toString(36)}`;
const BN = 'Store Plix: {merchant_name}, এই সপ্তাহে Growth প্ল্যানে নতুন থিম এসেছে। দেখুন: {link}';
const EN = 'Store Plix: {merchant_name}, new themes are live on Growth this week. See: {link}';

const dhakaHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dhaka' }).format(new Date()));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  test.skip(dhakaHour() < 9 || dhakaHour() >= 20, 'promotional SMS only go out 09:00–21:00 Asia/Dhaka');
  reseedSuperAdmin();
  resetPlatformSms();
  admin = await adminLogin('admin-super-p89b');
  await ensurePrimary(admin);
  a = await verifiedMerchant('p89ba');
  b = await verifiedMerchant('p89bb');
});
test.afterAll(() => {
  a?.cleanup();
  b?.cleanup();
});

const growth = { kind: 'plan', plans: ['growth'] };

test('broadcast to Growth: estimate, typed count, STOP link per recipient', async ({ page, context }) => {
  test.setTimeout(180_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  await openSmsSettings(page, 'broadcasts');
  const card = section(page, 'New broadcast');
  await expect(card).toContainText('Promotional route · Approved');
  await card.getByLabel('Name (only admins see it)').fill(NAME);
  const langs = card.getByRole('group', { name: 'Broadcast language' });
  await card.locator('#broadcast-body').fill(BN);
  await expect(card.getByTestId('stop-footer')).toContainText('বন্ধ করতে: {link}');
  await langs.getByRole('button', { name: /^English/ }).click();
  await card.locator('#broadcast-body').fill(EN);
  await expect(card.getByTestId('stop-footer')).toContainText('STOP: {link}');
  await expect(card.getByTestId('broadcast-counter')).toContainText('characters incl. footer');

  await card.getByRole('radio', { name: /^By plan/ }).check();
  await card.getByRole('group', { name: 'Plans' }).getByRole('button', { name: /^Growth/ }).click();
  await card.getByRole('tablist', { name: 'When' }).getByRole('tab', { name: 'Send now' }).click();
  const estimate = await adminOk(admin, 'POST', '/broadcasts/estimate', { audience: growth, body_bn: BN, body_en: EN }, 200, 'estimate');
  expect(estimate.recipients).toBeGreaterThanOrEqual(2);
  expect([estimate.sender_id, estimate.sender_status, estimate.checks.sending_hours]).toEqual(['SPOffers', 'approved', true]);
  const panel = card.getByTestId('broadcast-estimate');
  await expect(panel).toContainText(`${estimate.recipients} merchants`, { timeout: 15_000 });

  await card.getByRole('button', { name: 'Review and schedule' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send this broadcast now?' });
  await expect(dlg).toContainText('SPOffers (promotional)');
  await expect(dlg).toContainText('STOP link added to both versions');
  const send = dlg.getByRole('button', { name: `Send to ${estimate.recipients} merchants` });
  await expect(send).toBeDisabled();
  await dlg.getByLabel(`Type ${estimate.recipients} to confirm`).fill(String(estimate.recipients + 1));
  await dlg.getByRole('checkbox', { name: 'I checked both language versions and the link.' }).check();
  await expect(send).toBeDisabled(); // wrong count
  await dlg.getByLabel(`Type ${estimate.recipients} to confirm`).fill(String(estimate.recipients));
  const mark = smsMark();
  await send.click();
  await expect(page.getByText(`Sending to ${estimate.recipients} merchants`)).toBeVisible();

  // The queue worker sends each recipient its own STOP link (bn: the shop's default SMS language).
  const smsA = await waitSent(mark, (m) => m.to === msisdn(a.phone) && m.text.includes('নতুন থিম'), 'broadcast SMS to A');
  const smsB = await waitSent(mark, (m) => m.to === msisdn(b.phone) && m.text.includes('নতুন থিম'), 'broadcast SMS to B');
  for (const sms of [smsA, smsB]) {
    expect(sms.text).toMatch(new RegExp(`বন্ধ করতে: ${urls.merchant.replace(/[.:/]/g, '\\$&')}/s/[A-Za-z0-9]{10}$`));
    expect(sms.text).not.toContain('\n');
    expect((sms as unknown as { route?: string }).route).toBe('promotional');
  }
  codeA = optOutCode(smsA.text);
  expect(optOutCode(smsB.text)).not.toBe(codeA);

  // Past broadcasts → View recipients (masked phones).
  const list = await adminOk(admin, 'GET', '/broadcasts', undefined, 200, 'broadcasts');
  const mine = (list as unknown as Array<{ id: string; name: string }>).find((x) => x.name === NAME)!;
  await expect.poll(async () => (await adminOk(admin, 'GET', `/broadcasts/${mine.id}`, undefined, 200, 'broadcast')).status, { timeout: 60_000 }).toBe('sent');
  const past = section(page, 'Past broadcasts');
  await page.reload();
  await past.getByRole('button', { name: `Actions for ${NAME}` }).first().click();
  await page.getByRole('menuitem', { name: 'View recipients' }).click();
  const drawer = page.getByRole('dialog', { name: 'Recipients' });
  await expect(drawer).toContainText(masked(a.phone));
  await expect(drawer).toContainText(masked(b.phone));
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('opt-out page /s/{code}: GET changes nothing, Stop offers opts out (link)', async ({ page }) => {
  const c = watchConsole(page);
  await page.goto(`${urls.merchant}/s/${codeA}`);
  await expect(page.getByText(`Stop Store Plix offers to ${masked(a.phone)}?`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(optOutState(a.email).at).toBeNull();
  await page.getByRole('button', { name: 'Stop offers' }).click();
  await expect(page.getByText('You won’t get Store Plix offers by SMS any more')).toBeVisible();
  const st = optOutState(a.email);
  expect([!!st.at, st.source]).toEqual([true, 'link']);
  await page.reload();
  await expect(page.getByText('You won’t get Store Plix offers by SMS any more')).toBeVisible({ timeout: 20_000 });

  await page.goto(`${urls.merchant}/s/ZZZZZZZZZZ`);
  await expect(page.getByText('This link is not valid')).toBeVisible({ timeout: 20_000 });
  await page.goto(`${urls.merchant}/s/test`);
  await expect(page.getByText('This was a test message')).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('second broadcast: opted-out owner skipped, stale count 409, weekly cap', async () => {
  test.setTimeout(150_000);
  const est = await adminOk(admin, 'POST', '/broadcasts/estimate', { audience: growth, body_bn: BN, body_en: EN }, 200, 'estimate 2');
  expect(est.skipped.opted_out).toBeGreaterThanOrEqual(1);
  const draft = await adminOk(admin, 'POST', '/broadcasts', { name: `${NAME} 2`, body_bn: BN, body_en: EN, audience: growth, scheduled_at: null }, 201, 'draft 2');
  let r = await adminSms(admin, 'POST', `/broadcasts/${draft.id}/schedule`, { acknowledged: true, confirm_recipients: est.recipients + 5, revision: draft.revision });
  expect([r.status, r.json.error?.code]).toEqual([409, 'broadcast_estimate_changed']);
  expect(r.json.error?.details?.recipients).toBe(est.recipients);
  const mark = smsMark();
  r = await adminSms(admin, 'POST', `/broadcasts/${draft.id}/schedule`, { acknowledged: true, confirm_recipients: est.recipients, revision: draft.revision });
  expect(r.status, r.text).toBe(200);
  await waitSent(mark, (m) => m.to === msisdn(b.phone) && m.text.includes('নতুন থিম'), 'second broadcast SMS to B');
  await expect.poll(async () => (await adminOk(admin, 'GET', `/broadcasts/${draft.id}`, undefined, 200, 'broadcast 2')).status, { timeout: 60_000 }).toBe('sent');
  expect(sentSince(mark).filter((m) => m.to === msisdn(a.phone)), 'the opted-out owner got a promotional SMS').toEqual([]);
  const recips = (await adminOk(admin, 'GET', `/broadcasts/${draft.id}/recipients`, undefined, 200, 'recipients')) as unknown as Array<{ tenant: { id: string }; status: string; skip_reason: string | null }>;
  expect(recips.find((x) => x.tenant.id === a.session.tenantId)?.skip_reason ?? 'not listed').toMatch(/opted_out|not listed/);

  // B has had 2 promotional SMS in 7 days: a third estimate skips B for the weekly cap.
  const third = await adminOk(admin, 'POST', '/broadcasts/estimate', { audience: growth, body_bn: BN, body_en: EN }, 200, 'estimate 3');
  expect(third.skipped.weekly_cap).toBeGreaterThanOrEqual(1);
  expect(third.recipients).toBeLessThan(est.recipients);
});

test('Account → Store Plix SMS switch turns offers back on and off', async ({ page, context }) => {
  const c = watchConsole(page);
  await signInDashboard(context, a.session);
  await page.goto(`${urls.merchant}/account`);
  const card = page.getByRole('region', { name: 'Store Plix SMS' });
  await expect(card).toContainText('Sign-in codes, invoices and account messages are always sent.', { timeout: 20_000 });
  await expect(card).toContainText(`Sent to ${masked(a.phone)}`);
  const sw = card.getByRole('switch', { name: 'Offers and news from Store Plix by SMS' });
  await expect(sw).toHaveAttribute('aria-checked', 'false'); // opted out by the link
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(optOutState(a.email).at).toBeNull();
  expect((await api(a.session, 'GET', '/account/sms-preferences')).json.data?.promotional).toBe(true);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  const st = optOutState(a.email);
  expect([!!st.at, st.source]).toEqual([true, 'account']);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
