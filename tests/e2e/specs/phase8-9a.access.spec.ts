import { expect, test } from '@playwright/test';
import { createMember, signInDashboard, type Session, type ThrowawayMember } from '../support/api';
import type { CommerceShop } from '../support/commerce';
import { mUrl } from '../support/locations';
import { purchasingShop } from '../support/purchasing';
import { createRole, noAccess } from '../support/roles';
import {
  cleanupSmsShop,
  creditsRaw,
  ledgerRaw,
  messagesRaw,
  openSms,
  overviewRaw,
  panel,
  purchaseRaw,
  putTemplateRaw,
  randomSenderId,
  requestSenderIdRaw,
  senderIdsRaw,
  smsTabs,
  template,
  templatesRaw,
  testSmsRaw,
} from '../support/sms';

/**
 * PHASE-8-9A §2, §10.1, §12 (P89A-25, S208, S210):
 *  - no SMS keys (orders.view only) → the page shows the 403 state, every SMS route 403, no Messaging card;
 *  - billing.view only → Overview / Templates / Buy credits tabs, read-only templates, "Only the shop owner can buy
 *    credits", purchase 403;
 *  - integrations.manage only → Sender ID + SMS log tabs, may request a sender ID, template writes 403 (read-only editor);
 *  - the system admin edits templates but can't buy credits (owner only);
 *  - another tenant's store → 404 on every SMS route; ledgers never cross tenants.
 */
test.describe.configure({ mode: 'serial' });

let a: CommerceShop;
let b: CommerceShop;
let none: ThrowawayMember | undefined;
let biller: ThrowawayMember | undefined;
let integrator: ThrowawayMember | undefined;
let admin: ThrowawayMember | undefined;
const as = (m: ThrowawayMember | undefined): Session => ({ ...m!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  a = await purchasingShop('smsacc', 'growth', 2); // custom roles are on Growth
  b = await purchasingShop('smsaccb', 'starter', 2);
  none = await createMember(a.s, { role_id: (await createRole(a.s, 'QA SMS none', ['orders.view'])).id as string });
  biller = await createMember(a.s, { role_id: (await createRole(a.s, 'QA SMS billing', ['billing.view'])).id as string });
  integrator = await createMember(a.s, { role_id: (await createRole(a.s, 'QA SMS integrations', ['integrations.manage'])).id as string });
  admin = await createMember(a.s, 'admin');
});
test.afterAll(async () => {
  for (const m of [none, biller, integrator, admin]) await m?.cleanup().catch(() => undefined);
  cleanupSmsShop(a);
  cleanupSmsShop(b);
});

test('no SMS keys: 403 page, 403 on every route, no Messaging card', async ({ page, context }) => {
  const s = as(none);
  for (const [what, p] of [
    ['overview', overviewRaw(a.s, s)],
    ['templates', templatesRaw(a.s, s)],
    ['test', testSmsRaw(a.s, 'en', s)],
    ['sender ids', senderIdsRaw(a.s, s)],
    ['log', messagesRaw(a.s, '', s)],
    ['credits', creditsRaw(a.s, s)],
    ['ledger', ledgerRaw(a.s, '', s)],
    ['purchase', purchaseRaw(a.s, 'credits_1000', 'bkash', s)],
  ] as const) {
    const r = await p;
    expect([what, r.status]).toEqual([what, 403]);
  }
  await signInDashboard(context, s);
  await page.goto(mUrl('/integrations/sms'));
  await expect(noAccess(page)).toBeVisible({ timeout: 20_000 });
  await page.goto(mUrl('/integrations'));
  await expect(page.getByRole('heading', { name: 'Messaging' })).toHaveCount(0);
});

test('billing.view only: overview/templates/credits tabs, read-only, cannot buy', async ({ page, context }) => {
  const s = as(biller);
  expect((await overviewRaw(a.s, s)).status).toBe(200);
  expect((await ledgerRaw(a.s, '', s)).status).toBe(200);
  expect((await senderIdsRaw(a.s, s)).status).toBe(403);
  expect((await messagesRaw(a.s, '', s)).status).toBe(403);
  expect((await purchaseRaw(a.s, 'credits_1000', 'bkash', s)).status).toBe(403);
  const t = await template(a.s, 'order_placed', 'en');
  expect((await putTemplateRaw(a.s, 'order_placed', 'en', `${t.body} `, t.revision, s)).status).toBe(403);

  await signInDashboard(context, s);
  await openSms(page);
  await expect(smsTabs(page).getByRole('tab')).toHaveText(['Overview', 'Templates', 'Buy credits']);
  const header = page.getByRole('region', { name: 'SMS', exact: true });
  await expect(header.getByRole('button', { name: 'Buy credits' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Send test SMS' })).toHaveCount(0);
  await expect(panel(page, 'Automatic messages').getByRole('tablist', { name: 'SMS language' }).getByRole('tab').first()).toBeDisabled();
  await openSms(page, 'credits');
  await expect(panel(page, 'Order summary')).toContainText('Only the shop owner can buy credits');
  await expect(page.getByRole('button', { name: /^Pay ৳/ })).toHaveCount(0);
  await openSms(page, 'log'); // hidden tab → overview
  await expect(smsTabs(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
});

test('integrations.manage only: sender ID + log; requests allowed; templates read-only', async ({ page, context }) => {
  const s = as(integrator);
  expect((await senderIdsRaw(a.s, s)).status).toBe(200);
  expect((await messagesRaw(a.s, '', s)).status).toBe(200);
  const t = await template(a.s, 'order_placed', 'en');
  expect((await putTemplateRaw(a.s, 'order_placed', 'en', `${t.body} `, t.revision, s)).status).toBe(403);
  expect((await purchaseRaw(a.s, 'credits_1000', 'bkash', s)).status).toBe(403);

  await signInDashboard(context, s);
  await openSms(page, 'templates', '&key=order_placed');
  await expect(smsTabs(page).getByRole('tab')).toHaveText(['Overview', 'Templates', 'Sender ID', 'SMS log', 'Buy credits']);
  await expect(page.getByText('Only owners and managers can edit messages.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute('readonly', '');
  await openSms(page, 'sender-id');
  await expect(page.getByRole('form', { name: 'Request a masked sender ID' })).toBeVisible();
  const r = await requestSenderIdRaw(a.s, randomSenderId(), { as: s });
  expect(r.status, r.text).toBe(201);
});

test('system admin: edits templates, cannot buy credits', async () => {
  const s = as(admin);
  const t = await template(a.s, 'order_placed', 'en');
  const put = await putTemplateRaw(a.s, 'order_placed', 'en', `${t.body} Thanks!`, t.revision, s);
  expect(put.status, put.text).toBe(200);
  const buy = await purchaseRaw(a.s, 'credits_1000', 'bkash', s);
  expect([buy.status, buy.json.error?.code]).toEqual([403, 'forbidden']);
});

test('S208: another tenant’s store → 404 on every SMS route; ledgers never cross', async () => {
  const foreign = { ...a.s, storeId: b.s.storeId };
  for (const [what, p] of [
    ['overview', overviewRaw(foreign)],
    ['templates', templatesRaw(foreign)],
    ['test', testSmsRaw(foreign, 'en')],
    ['sender ids', senderIdsRaw(foreign)],
    ['log', messagesRaw(foreign)],
    ['put template', putTemplateRaw(foreign, 'order_placed', 'en', 'x {number}', 1)],
  ] as const) {
    const r = await p;
    expect([what, r.status]).toEqual([what, 404]);
  }
  const la = await ledgerRaw(a.s);
  const lb = await ledgerRaw(b.s);
  const ids = new Set((la.json.data as Array<{ id: string }>).map((e) => e.id));
  expect((lb.json.data as Array<{ id: string }>).some((e) => ids.has(e.id))).toBe(false);
});
