import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { clickFakeBilling } from '../support/billing';
import { setPlan, type CommerceShop } from '../support/commerce';
import { purchasingShop } from '../support/purchasing';
import { watchConsole } from '../support/roles';
import { cleanupSmsShop, credits, ledgerRaw, messages, openSms, overview, panel, seedAllowanceUsage, testSmsRaw, verifyOwnerPhone } from '../support/sms';

/**
 * PHASE-8-9A §5.3, §12.5 (P89A-5, P89A-6, P89A-9, S211, S212) with the Phase 7 fake billing gateway (BILLING_FAKE=true):
 *  - Buy 1,000 credits with bKash from the Buy credits tab → fake hosted page "Pay" → back on
 *    /integrations/sms?tab=credits&payment=… → "1,000 credits added", balance +1,000, Purchase history "Paid", Credit
 *    history "Purchase · SP-…".
 *  - "Pay, then time out" → back with the payment still pending → "Confirming your payment…" card, Back to SMS.
 *  - Allowance used up (seeded usage on Free, 200/month) → the next transactional SMS is paid from credits (log "Credits",
 *    ledger "consume" −1); the overview credits card says so.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('smscr', 'starter', 2);
});
test.afterAll(() => cleanupSmsShop(shop));

test('buy 1,000 credits with bKash (fake gateway) → credits added once, history + ledger', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openSms(page, 'credits');
  const packs = page.getByRole('radiogroup', { name: 'Credit pack' });
  await expect(packs.getByRole('radio')).toHaveCount(3);
  await expect(packs).toContainText('Most popular');
  await expect(packs).toContainText('Best value');
  await expect(packs.getByRole('radio', { checked: true })).toContainText('5,000'); // default pack
  await packs.getByRole('radio').filter({ hasText: /^1,000/ }).click();
  await page.getByRole('radiogroup', { name: 'Pay with' }).getByRole('radio', { name: /bKash/ }).click();
  const summary = panel(page, 'Order summary');
  await expect(summary).toContainText('0 → 1,000');
  await expect(summary).toContainText('Credits are added only after we confirm the payment');
  await expect(panel(page, 'Purchase history')).toContainText('No purchases yet');
  await summary.getByRole('button', { name: /^Pay ৳\s?350 with bKash$/ }).click();

  await clickFakeBilling(page, 'pay');
  await expect(page).toHaveURL(/\/integrations\/sms\?tab=credits&payment=/, { timeout: 30_000 });
  const done = panel(page, 'Payment confirmed');
  await expect(done.getByRole('heading', { name: '1,000 credits added' })).toBeVisible({ timeout: 30_000 });
  await expect(done).toContainText('Payment confirmed by bKash');
  expect((await credits(shop.s)).balance).toBe(1000);
  const led = await ledgerRaw(shop.s);
  expect(led.json.data.filter((e: { type: string }) => e.type === 'purchase').map((e: { credits: number }) => e.credits)).toEqual([1000]);
  await expect(panel(page, 'Purchase history')).toContainText('Paid');
  await expect(panel(page, 'Credit history')).toContainText(/Purchase · SP-/);
  // Reloading the return URL never grants twice (rule 8: verified once per invoice).
  await page.reload();
  await expect(panel(page, 'Payment confirmed')).toBeVisible({ timeout: 30_000 });
  expect((await credits(shop.s)).balance).toBe(1000);
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/tab=credits$/);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('"Pay, then time out" → Confirming your payment… with Back to SMS', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signInDashboard(context, shop.s);
  await openSms(page, 'credits');
  await page.getByRole('radiogroup', { name: 'Credit pack' }).getByRole('radio').filter({ hasText: /^1,000/ }).click();
  await panel(page, 'Order summary').getByRole('button', { name: /^Pay ৳\s?350 with bKash$/ }).click();
  await clickFakeBilling(page, 'timeout');
  await expect(page).toHaveURL(/\/integrations\/sms\?tab=credits&payment=/, { timeout: 30_000 });
  const confirming = panel(page, 'Confirming your payment');
  await expect(confirming.getByRole('heading', { name: 'Confirming your payment…' })).toBeVisible({ timeout: 20_000 });
  await expect(confirming).toContainText('We’re checking with bKash');
  await expect(page.getByRole('status').filter({ hasText: 'You have an unpaid SMS credit invoice' })).toBeVisible();
  expect((await credits(shop.s)).balance, 'nothing granted while the payment is pending').toBe(1000);
  await confirming.getByRole('button', { name: 'Back to SMS' }).click();
  await expect(page).toHaveURL(/tab=credits$/);
  await expect(panel(page, 'Purchase history')).toContainText('Pending');
});

test('allowance used up → the next SMS is paid from credits (log "Credits", ledger consume)', async ({ page, context }) => {
  test.setTimeout(120_000);
  setPlan(shop.s, 'free');
  const ov = await overview(shop.s);
  expect(ov.allowance.transactional.limit).toBe(200);
  seedAllowanceUsage(shop.s, ov.allowance.transactional.remaining);
  expect((await overview(shop.s)).allowance.transactional.remaining).toBe(0);
  verifyOwnerPhone(shop.s, shop.t.email);
  const before = (await credits(shop.s)).balance as number;
  const r = await testSmsRaw(shop.s, 'en');
  expect([r.status, r.json.data?.charged_from, r.json.data?.parts], r.text).toEqual([200, 'credits', 1]);
  expect((await credits(shop.s)).balance).toBe(before - 1);
  const rows = await messages(shop.s, 'filter[purpose]=sms_test');
  expect(rows[0].charged_from).toBe('credits');
  const consume = (await ledgerRaw(shop.s, 'filter[type]=consume')).json.data;
  expect(consume.map((e: { credits: number }) => e.credits)).toEqual([-1]);

  await signInDashboard(context, shop.s);
  await openSms(page, 'log');
  const table = page.getByRole('table', { name: 'SMS log' });
  await expect(table.getByRole('row').nth(1)).toContainText('Credits');
  await openSms(page);
  const card = panel(page, 'SMS credits');
  await expect(card).toContainText('0 of 200');
  await expect(card).toContainText(`${(before - 1).toLocaleString('en-US')}`);
  setPlan(shop.s, 'starter');
});
