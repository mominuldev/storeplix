import { expect, test, type Page } from '@playwright/test';
import { api, signInDashboard } from '../support/api';
import { adminApi, adminLogin, adminUrl, reseedSuperAdmin, signInAdminApp, type AdminSession } from '../support/admin';
import { confirmedOrder, type CommerceShop } from '../support/commerce';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { cleanupSmsShop, credits, ledgerRaw, msisdn, openSms, overview, panel, randomSenderId, requestSenderIdRaw, smsMark, waitSms } from '../support/sms';

/**
 * PHASE-8-9A §8.3, §13 (P89A-18, S213, S215, S216) super admin:
 *  - Sender ID requests: queue (Pending review count, search), drawer; Approve needs the "Registered on REVE SMS / BTRC"
 *    tick + a reason → the shop's overview shows the masked sender and the next order SMS goes out with `sender_id`
 *    and WITHOUT the "{Shop}: " prefix; Reject with a reason → the merchant's Sender ID tab shows it + Request again.
 *  - Merchant detail → Billing → SMS credits: Adjust credits Grant 200 (preset reason) → balance 200, the merchant's
 *    ledger shows "admin_adjust" with the reason; Deduct beyond the balance is blocked in the dialog; Deduct 50 → 150.
 */
test.describe.configure({ mode: 'serial' });

let approveShop: CommerceShop;
let rejectShop: CommerceShop;
let admin: AdminSession;
const APPROVE_ID = randomSenderId();
const REJECT_ID = randomSenderId();

test.beforeAll(async () => {
  test.setTimeout(300_000);
  reseedSuperAdmin();
  admin = await adminLogin('admin-super-p89a');
  approveShop = await purchasingShop('smsadm', 'starter', 10);
  rejectShop = await purchasingShop('smsrej', 'starter', 2);
  const set = await api(approveShop.s, 'PATCH', `/stores/${approveShop.s.storeId}/settings`, { notifications: { sms_language: 'en', customer_sms: { order_confirmed: true } } });
  expect(set.status).toBe(200);
  for (const [s, id] of [[approveShop.s, APPROVE_ID], [rejectShop.s, REJECT_ID]] as const) {
    const r = await requestSenderIdRaw(s, id, { business: 'QA Trading House' });
    expect(r.status, r.text).toBe(201);
  }
});
test.afterAll(() => {
  cleanupSmsShop(approveShop);
  cleanupSmsShop(rejectShop);
});

async function openRequest(page: Page, id: string) {
  await page.goto(`${adminUrl}/sender-ids`);
  await expect(page.getByRole('heading', { name: 'Sender ID requests' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { name: /Pending review/ }).or(page.getByRole('radio', { name: /Pending review/ })).or(page.getByRole('button', { name: /Pending review/ })).first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search shop or sender ID' }).fill(id);
  await expect(page).toHaveURL(new RegExp(`q=${id}`));
  await page.getByText(id, { exact: true }).first().click();
  const drawer = page.getByRole('dialog').filter({ hasText: 'Before you approve' });
  await expect(drawer).toContainText('Trade licence');
  await expect(drawer).toContainText('QA Trading House');
  return drawer;
}

test('approve: tick + reason → the shop sends as the ID without the prefix', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await signInAdminApp(context, admin);
  const drawer = await openRequest(page, APPROVE_ID);
  await expect(drawer).toContainText('Storeplix (platform default)');
  await drawer.getByRole('button', { name: 'Approve' }).click();
  const dlg = page.getByRole('dialog', { name: `Approve ${APPROVE_ID}?` });
  await dlg.getByRole('textbox', { name: /Internal reason/ }).fill('Registered on REVE, ticket SP-8901');
  await dlg.getByRole('button', { name: 'Approve' }).click();
  await expect(dlg).toContainText('Confirm the ID is registered and active on REVE SMS first');
  await dlg.getByRole('checkbox', { name: /Registered on REVE SMS \/ BTRC/ }).check();
  await dlg.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(`${APPROVE_ID} approved · the shop now sends as ${APPROVE_ID}`)).toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);

  const ov = await overview(approveShop.s);
  expect([ov.sender.type, ov.sender.sender_id]).toEqual(['masked', APPROVE_ID]);
  const mark = smsMark();
  const order = await confirmedOrder(approveShop);
  const sms = await waitSms(mark, (m) => m.to === msisdn(order.phone) && m.text.includes('is confirmed'), `order_confirmed SMS for ${order.number}`);
  expect([sms.sender_id, sms.text]).toEqual([APPROVE_ID, `Order ${order.number} is confirmed.`]);

  // Merchant sees the approved ID.
  await signInDashboard(context, approveShop.s);
  await openSms(page, 'sender-id');
  const current = panel(page, 'Current sender');
  await expect(current).toContainText(APPROVE_ID);
  await expect(current).toContainText('Approved');
  await expect(current).toContainText('the shop-name prefix is removed');
});

test('reject with a reason → the merchant sees it and can request again', async ({ page, context }) => {
  await signInAdminApp(context, admin);
  const drawer = await openRequest(page, REJECT_ID);
  await drawer.getByRole('button', { name: 'Reject' }).click();
  await expect(drawer.getByRole('textbox', { name: 'Reason if you reject' })).toHaveAttribute('aria-invalid', 'true');
  await drawer.getByRole('button', { name: 'Licence unreadable' }).click();
  await expect(drawer.getByRole('textbox', { name: 'Reason if you reject' })).toHaveValue(/couldn’t read the trade licence/);
  await drawer.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(`${REJECT_ID} rejected · the owner was emailed`)).toBeVisible();
  const r = await adminApi(admin, 'GET', `/admin/sender-ids?filter[status]=rejected&q=${REJECT_ID}`);
  expect(r.json.data?.[0]?.status).toBe('rejected');

  await signInDashboard(context, rejectShop.s);
  await openSms(page, 'sender-id');
  const decision = panel(page, 'When the review is done');
  await expect(decision).toContainText(REJECT_ID);
  await expect(decision).toContainText('Rejected');
  await expect(decision).toContainText('We couldn’t read the trade licence');
  await decision.getByRole('button', { name: 'Request again' }).click();
  await expect(page.getByRole('form', { name: 'Request a masked sender ID' }).getByRole('textbox', { name: 'Sender ID' })).toHaveValue(REJECT_ID);
});

test('adjust credits: grant 200 → ledger with the reason; deduct beyond the balance blocked; deduct 50', async ({ page, context }) => {
  test.setTimeout(120_000);
  const tenantId = rejectShop.s.tenantId;
  await signInAdminApp(context, admin);
  await page.goto(`${adminUrl}/merchants/${tenantId}?tab=billing`);
  // The Billing-tab card: the nearest ancestor of the "SMS credits" heading that also holds the ledger table.
  const card = page.getByRole('heading', { name: 'SMS credits', exact: true }).locator('xpath=ancestor::div[.//*[@aria-label="SMS credit ledger"]][1]');
  await expect(card).toContainText('Balance', { timeout: 20_000 });
  await card.getByRole('button', { name: 'Adjust credits' }).click();
  let dlg = page.getByRole('dialog', { name: 'Adjust SMS credits' });
  await dlg.getByRole('textbox', { name: /Credits to grant/ }).fill('200');
  await expect(dlg.getByTestId('adjust-delta')).toHaveText('+200');
  await expect(dlg).toContainText('0 → 200');
  await dlg.getByRole('radio', { name: /Promotion/ }).check();
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Granted 200 SMS credits · balance 200')).toBeVisible();
  expect((await credits(rejectShop.s)).balance).toBe(200);
  const led = await ledgerRaw(rejectShop.s);
  expect([led.json.data?.[0]?.type, led.json.data?.[0]?.credits, led.json.data?.[0]?.reason]).toEqual(['admin_adjust', 200, 'Promotion: bonus SMS credits from Store Plix.']);
  await expect(card.getByRole('table', { name: 'SMS credit ledger' }).or(card.getByRole('grid', { name: 'SMS credit ledger' })).first()).toContainText('Promotion: bonus SMS credits from Store Plix.');

  await card.getByRole('button', { name: 'Adjust credits' }).click();
  dlg = page.getByRole('dialog', { name: 'Adjust SMS credits' });
  await dlg.getByRole('radio', { name: /Deduct credits/ }).check();
  await dlg.getByRole('textbox', { name: /Credits to deduct/ }).fill('500');
  await expect(dlg).toContainText('200 → -300');
  await expect(dlg.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await dlg.getByRole('textbox', { name: /Credits to deduct/ }).fill('50');
  await dlg.getByRole('radio', { name: /Correction/ }).check();
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Deducted 50 SMS credits · balance 150')).toBeVisible();
  expect((await credits(rejectShop.s)).balance).toBe(150);

  // The merchant's credit history shows the adjustment with the reason.
  await signInDashboard(context, rejectShop.s);
  await openSms(page, 'credits');
  const hist = panel(page, 'Credit history');
  await expect(hist).toContainText('Adjusted by Store Plix');
  await expect(hist).toContainText('Promotion: bonus SMS credits from Store Plix.');
});
