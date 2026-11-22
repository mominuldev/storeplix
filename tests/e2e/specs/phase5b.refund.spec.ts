import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { apiCall, signInDashboard, urls } from '../support/api';
import { connectFakeGateway, merchantOrder, placeAndPay, setupShop, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5B-CONTRACT §13 QA "refund" (P5B-24, §4.5): a bKash-paid order (fake gateway) gets a partial gateway refund
 * from the order detail Payments card. The refund row starts and ends `succeeded` with the fake driver (bKash is
 * synchronous); the charge's `refunded_amount`, the order `refunded_amount` and `payment_status` follow. Then API:
 * over-refund 422, Idempotency-Key replay returns the same refund.
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await setupShop('rfd', { stock: 10 });
  await connectFakeGateway(shop.s, 'bkash', { isDefault: true });
});
test.afterAll(() => shop?.cleanup());

/** WEB Payments card (orders/payments.tsx): the charge row's "Refund ৳ N bKash payment" → "Refund to bKash" dialog. */
async function refundFromPaymentsCard(page: Page, taka: number): Promise<void> {
  await page.getByRole('button', { name: /^Refund ৳\s?[\d,]+ bKash payment$/ }).first().click();
  const dialog = page.getByRole('dialog', { name: /Refund to bKash/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount').fill(String(taka));
  await dialog.getByRole('button', { name: 'Refund', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

test('gateway partial refund from the order detail', async ({ page, context }) => {
  test.setTimeout(150_000);
  const paid = await placeAndPay(shop, shop.simple.variantId, 2); // 2 × 500 + 60 = 1,060
  await expect.poll(async () => (await merchantOrder(shop.s, paid.orderId)).payment_status, { timeout: 20_000 }).toBe('paid');
  const before = await merchantOrder(shop.s, paid.orderId);
  expect(before.paid_amount).toBe(106000);
  const charge = (before.payments as { id: string; type: string; provider: string; can_refund: boolean }[]).find((p) => p.type === 'charge' && p.provider === 'bkash')!;
  expect(charge.can_refund).toBe(true);

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/${paid.orderId}`);
  await refundFromPaymentsCard(page, 200);

  await expect.poll(async () => (await merchantOrder(shop.s, paid.orderId)).refunded_amount, { timeout: 20_000 }).toBe(20000);
  const o = await merchantOrder(shop.s, paid.orderId);
  expect(o.payment_status).toBe('partially_refunded');
  const refund = (o.payments as { type: string; method: string | null; status: string; amount: number; provider: string }[]).find((p) => p.type === 'refund');
  expect([refund?.method, refund?.status, refund?.amount, refund?.provider]).toEqual(['gateway', 'succeeded', 20000, 'bkash']);
  const ch = (o.payments as { id: string; refunded_amount: number }[]).find((p) => p.id === charge.id);
  expect(ch?.refunded_amount).toBe(20000);
  await expect(page.getByText(/Refunded|Refund/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('refund.png'), fullPage: true });

  // API: over the charge's refundable balance → 422; idempotent replay → same row
  const refund2 = (body: object, key: string) => apiCall(shop.s, 'POST', `/stores/${shop.s.storeId}/orders/${paid.orderId}/refunds`, { json: body, headers: { 'Idempotency-Key': key } });
  const over = await refund2({ amount: 106000 - 20000 + 1, method: 'gateway', payment_id: charge.id }, randomUUID());
  expect([over.status, over.json.error?.code]).toEqual([422, 'refund_exceeds_paid']);
  const key = randomUUID();
  const a = await refund2({ amount: 10000, method: 'gateway', payment_id: charge.id, note: 'second' }, key);
  expect(a.status, a.text).toBe(201);
  const b = await refund2({ amount: 10000, method: 'gateway', payment_id: charge.id, note: 'second' }, key);
  expect([b.status, b.json.data?.id]).toEqual([201, a.json.data.id]);
  expect((await merchantOrder(shop.s, paid.orderId)).refunded_amount).toBe(30000);
});
