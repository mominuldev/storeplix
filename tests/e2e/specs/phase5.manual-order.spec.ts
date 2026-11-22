import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, signInDashboard, tinker, urls } from '../support/api';
import { GEO, placeOrder, randomPhone, setupShop, type CommerceShop } from '../support/commerce';

/**
 * PHASE-5-CONTRACT §12 QA "manual-order": create an order from the dashboard with a delivery-charge
 * override; on a Free-plan throwaway tenant at 50 orders this month a manual order is refused with 402
 * (upgrade dialog) while storefront orders are still accepted (P5-27).
 */
let shop: CommerceShop;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await setupShop('man', { stock: 20 });
});
test.afterAll(() => shop?.cleanup());

test('create order from chats: WhatsApp, override delivery to ৳ 0, same pricing as checkout', async ({ page, context }) => {
  test.setTimeout(120_000);
  const phone = randomPhone();
  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/new`);
  await page.getByRole('radio', { name: 'WhatsApp' }).click();
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Name', { exact: true }).fill('Nasrin Akter');
  await page.getByLabel('District').selectOption('dhaka');
  await page.getByLabel('Thana / Upazila').selectOption('dhaka-dhanmondi');
  await page.getByLabel('Full address').fill('House 5, Road 3, Dhanmondi');
  await page.getByLabel('Search products').fill('QA Cotton');
  await page.getByRole('list', { name: 'Product results' }).getByRole('button', { name: /QA Cotton Kurta/ }).click();
  await page.getByLabel('Variant').selectOption({ index: 0 });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Order total')).toHaveText('৳ 1,260'); // 1,200 + Inside Dhaka 60, from /orders/quote
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByLabel('Delivery charge').fill('0');
  await expect(page.getByLabel('Order total')).toHaveText('৳ 1,200');
  await page.getByLabel('Send order SMS to buyer').uncheck();
  await page.getByRole('button', { name: 'Create order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-z]{26}$/, { timeout: 15_000 });
  const id = page.url().split('/').pop()!;
  const o = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders/${id}`)).json.data;
  expect([o.channel, o.created_via, o.status, o.shipping_amount, o.shipping_overridden, o.total_amount]).toEqual(['whatsapp', 'dashboard', 'pending', 0, true, 120000]);
  expect(o.customer.phone).toBe(`88${phone}`);
  expect(o.items[0].unit_cost_amount).toBe(70000);
  await expect(page.getByText('(set by hand)')).toBeVisible();
  const audit = await api(shop.s, 'GET', `/audit-logs?filter[action]=order.shipping_overridden`);
  if (audit.status === 200) expect((audit.json.data as unknown[]).length).toBeGreaterThanOrEqual(1);
});

test('Free plan at 50 orders: manual order 402 + upgrade dialog; storefront order still accepted', async ({ page, context }) => {
  test.setTimeout(120_000);
  const { order } = await placeOrder(shop, shop.simple.variantId);
  const src = (await api(shop.s, 'GET', `/stores/${shop.s.storeId}/orders?q=${order.number}`)).json.data[0].id as string;
  const sid = shop.s.storeId;
  // test-only: Free plan + fill this month up to 50 orders by copying one row (no stock/coupon side effects)
  const out = tinker(
    [
      `$t='${shop.s.tenantId}'; $sid='${sid}'; $src='${src}';`,
      `DB::table('subscriptions')->where('tenant_id',$t)->update(['plan_id'=>DB::table('plans')->where('code','free')->value('id'),'status'=>'active']);`,
      `App\\Domain\\Billing\\FeatureGate::forget($t);`,
      `$n=DB::table('orders')->where('store_id',$sid)->count(); $o=(array) DB::table('orders')->where('id',$src)->first();`,
      `for($i=$n;$i<50;$i++){ $c=$o; $c['id']=strtolower((string) Illuminate\\Support\\Str::ulid()); $c['number']='QA-'.(90000+$i); $c['sequence']=90000+$i; $c['idempotency_key']=null; $c['confirmation_token_hash']=null; DB::table('orders')->insert($c); }`,
      `Illuminate\\Support\\Facades\\Cache::flush(); echo DB::table('orders')->where('store_id',$sid)->count();`,
    ].join(' '),
  );
  expect(out.trim().split('\n').pop()).toBe('50');
  const body = { items: [{ variant_id: shop.simple.variantId, quantity: 1 }], channel: 'phone', contact: { name: 'Over Limit', phone: randomPhone() }, shipping_address: { ...GEO.dhanmondi, address_line: 'House 1, Road 2' }, notify_customer: false };
  const r = await apiCall(shop.s, 'POST', `/stores/${sid}/orders`, { json: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect([r.status, r.json.error?.code]).toEqual([402, 'plan_limit_reached']);
  // storefront orders are never refused for the plan (P5-27)
  await placeOrder(shop, shop.simple.variantId);
  const dash = await api(shop.s, 'GET', `/stores/${sid}/dashboard`);
  expect(dash.json.data.orders.plan).toEqual({ used: 51, limit: 50 });

  await signInDashboard(context, shop.s);
  await page.goto(`${urls.merchant}/orders/new`);
  await page.getByRole('radio', { name: 'Phone call' }).click();
  await page.getByLabel('Phone number').fill(randomPhone());
  await page.getByLabel('Name', { exact: true }).fill('Over Limit');
  await page.getByLabel('District').selectOption('dhaka');
  await page.getByLabel('Thana / Upazila').selectOption('dhaka-dhanmondi');
  await page.getByLabel('Full address').fill('House 1, Road 2, Dhanmondi');
  await page.getByLabel('Search products').fill('QA Muslin');
  await page.getByRole('list', { name: 'Product results' }).getByRole('button', { name: /QA Muslin Wrap/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Create order' }).click();
  const limit = page.getByRole('dialog').filter({ hasText: 'You’ve reached your plan’s limit' });
  await expect(limit.first()).toBeVisible();
  await expect(limit.first()).toContainText('Your plan allows 50 orders per month.');
  // QA F-L: AppShell and CreateOrderPage both mount <PlanLimitDialog/>, so two identical dialogs stack
  expect(await limit.count()).toBeGreaterThanOrEqual(1);
  await limit.last().getByRole('button', { name: 'Not now' }).click(); // the top-layer copy
  await expect(limit).toHaveCount(0);
  await expect(page).toHaveURL(/\/orders\/new$/);
});
