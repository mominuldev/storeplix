import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, apiCall, signInDashboard, tinker, unique, urls } from '../support/api';
import { connectFakeCourier, fakeCourierCredentials, ensurePickup, setPlan, setupShop, type CommerceShop } from '../support/commerce';
import { clock, report } from '../support/billing';
import { openDomains } from '../support/domains';

/**
 * PHASE-7-CONTRACT §2.1 + P7-17 live: every 402 carries `details.upgrade_plan` = the cheapest plan that allows it, and
 * the app-wide 402 dialog names that plan (§8.3). Free shop at 100 products → "Upgrade to Starter"; Starter third
 * custom domain → "Upgrade to Growth"; courier / bulk / profit gates on the API.
 */
test.describe('Free shop at its limits', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    shop = await setupShop('lim');
    await clock(shop.s, 'trial_ended'); // real trial end → Free
    // Test-only fill to exactly 100 products: copies of the simple product row (the limit counts product rows).
    const sid = shop.s.storeId;
    if (!/^[0-9a-z]{26}$/i.test(sid) || !/^[0-9a-z]{26}$/i.test(shop.simple.id)) throw new Error('bad id');
    const out = tinker(
      [
        `$sid='${sid}'; $src=(array) DB::table('products')->where('id','${shop.simple.id}')->first();`,
        `$n=DB::table('products')->where('store_id',$sid)->whereNull('deleted_at')->count();`,
        `for($i=$n;$i<100;$i++){ $c=$src; $c['id']=strtolower((string) Illuminate\\Support\\Str::ulid()); $c['slug']='qa-fill-'.$i.'-'.substr($c['id'],-6); if(array_key_exists('name',$c)){ $c['name']='QA fill '.$i; } DB::table('products')->insert($c); }`,
        `App\\Domain\\Billing\\FeatureGate::forget('${shop.s.tenantId}'); echo DB::table('products')->where('store_id',$sid)->whereNull('deleted_at')->count();`,
      ].join(' '),
    );
    expect(out.trim().split('\n').pop()).toBe('100');
  });
  test.afterAll(() => shop?.cleanup());

  test('API: product create at 100 → 402 plan_limit_reached with upgrade_plan [starter]', async () => {
    const r = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/products`, {
      name: 'QA one too many',
      status: 'draft',
      variants: [{ sku: unique('QA-OVER-').toUpperCase(), price_amount: 10000 }],
    });
    expect([r.status, r.json.error?.code]).toEqual([402, 'plan_limit_reached']);
    expect(r.json.error.details.products).toEqual([expect.stringMatching(/100 products/)]);
    expect(r.json.error.details.upgrade_plan).toEqual(['starter']);
    const f = (await api(shop.s, 'GET', '/features')).json.data;
    expect(f.limits.products).toEqual({ limit: 100, used: 100 });
  });

  test('UI: Save product → the 402 dialog says "Upgrade to Starter"', async ({ page, context }) => {
    test.setTimeout(90_000);
    await signInDashboard(context, shop.s);
    await page.goto(`${urls.merchant}/products/new`);
    await page.getByLabel(/^Product name/i).fill('QA one too many');
    await page.getByLabel(/^Price/i).first().fill('100');
    await page.getByLabel(/^SKU/i).first().fill(unique('QA-OVER-UI-').toUpperCase());
    const saved = page.waitForResponse((r) => /\/api\/v1\/stores\/[^/]+\/products$/.test(r.url()) && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Save product$/ }).click();
    expect((await saved).status()).toBe(402);
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible({ timeout: 10_000 });
    await expect(d.getByRole('button', { name: /Upgrade to Starter/ }).or(d.getByRole('link', { name: /Upgrade to Starter/ })).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('limit-products-402.png') });
  });

  test('API: couriers (Free = 1), bulk booking and profit reports answer 402 with the cheapest plan', async () => {
    await ensurePickup(shop.s);
    await connectFakeCourier(shop.s, 'steadfast');
    const second = await api(shop.s, 'PUT', `/stores/${shop.s.storeId}/couriers/redx`, { mode: 'sandbox', credentials: fakeCourierCredentials('redx'), settings: { pickup_location_id: await ensurePickup(shop.s) } });
    expect([second.status, second.json.error?.code]).toEqual([402, 'plan_limit_reached']);
    expect(second.json.error.details.upgrade_plan).toEqual(['starter']);

    const bulk = await apiCall(shop.s, 'POST', `/stores/${shop.s.storeId}/shipments/bulk`, { json: { provider: 'steadfast', order_ids: [] }, headers: { 'Idempotency-Key': randomUUID() } });
    expect([bulk.status, bulk.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect(bulk.json.error.details.upgrade_plan).toEqual(['starter']);

    const profit = await report(shop.s, 'profit');
    expect([profit.status, profit.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect(profit.json.error.details.upgrade_plan).toEqual(['growth']);
    // Free has no custom domains at all → feature gate, cheapest = starter
    const dom = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: `free-${unique('').toLowerCase()}.localhost` });
    expect(dom.status).toBe(402);
    expect(dom.json.error.details.upgrade_plan).toEqual(['starter']);
  });
});

test.describe('Starter shop: third custom domain', () => {
  let shop: CommerceShop;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    shop = await setupShop('limdom');
    setPlan(shop.s, 'starter'); // test-only: active Starter (custom_domains 2)
  });
  test.afterAll(() => shop?.cleanup());

  test('2 domains used → third 402 upgrade_plan [growth]; the dashboard says "Upgrade to Growth"', async ({ page, context }) => {
    test.setTimeout(90_000);
    const r = unique('').toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const h of [`a-${r}.localhost`, `b-${r}.localhost`]) {
      const add = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: h });
      expect(add.status, JSON.stringify(add.json)).toBe(201);
    }
    const third = await api(shop.s, 'POST', `/stores/${shop.s.storeId}/domains`, { hostname: `c-${r}.localhost` });
    expect([third.status, third.json.error?.code]).toEqual([402, 'plan_limit_reached']);
    expect(third.json.error.details.upgrade_plan).toEqual(['growth']);

    await signInDashboard(context, shop.s);
    await openDomains(page);
    await expect(page.getByText(/Upgrade to Growth/).first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: test.info().outputPath('limit-domains.png'), fullPage: true });
  });
});
