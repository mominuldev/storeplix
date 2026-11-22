import { expect, test } from '@playwright/test';
import { api, createTenant, signInDashboard, tinker, urls, type ThrowawayTenant } from '../support/api';
import { storefrontOrigin } from '../support/commerce';

/**
 * PHASE-5-CONTRACT §12 QA "onboarding-golive" (+ §15.7) on a throwaway tenant: Finish setup is refused
 * with the launch_blocked list (never exercised live by WEB) → fix the blockers → 05 → 06 → 07 → publish
 * → 08 "You're live"; the storefront's Coming soon page disappears in < 5 s.
 */
let t: ThrowawayTenant;
let origin: string;

test.beforeAll(async () => {
  t = await createTenant('live');
  const host = `${t.slug}.localhost`;
  origin = storefrontOrigin(host);
  // browser host only; the store stays draft (publish is the real check)
  tinker(
    `$sid='${t.session.storeId}'; $s=DB::table('stores')->where('id',$sid)->first(); DB::table('store_domains')->insert(['id'=>(string) Illuminate\\Support\\Str::ulid(),'tenant_id'=>$s->tenant_id,'store_id'=>$sid,'hostname'=>'${host}','type'=>'platform','status'=>'active','is_primary'=>false,'created_at'=>now(),'updated_at'=>now()]); Illuminate\\Support\\Facades\\Cache::flush(); echo 'ok';`,
  );
});
test.afterAll(() => t?.cleanup());

test('blocked publish lists every blocker; then 05 → 06 → 07 → publish → 08 and Coming soon disappears < 5 s', async ({ page, context }) => {
  test.setTimeout(150_000);
  const s = t.session;
  const sid = s.storeId;
  const checklist = await api(s, 'GET', `/stores/${sid}/launch-checklist`);
  expect(checklist.status).toBe(200);
  expect(checklist.json.data.can_publish).toBe(false);
  const req = Object.fromEntries((checklist.json.data.items as Array<{ key: string; required: boolean; done: boolean }>).map((i) => [i.key, [i.required, i.done]]));
  expect(req).toMatchObject({ products: [true, false], shipping: [true, false], payments: [true, true], policy_pages: [false, expect.any(Boolean)], first_order: [false, false] });

  const blocked = await api(s, 'POST', `/stores/${sid}/publish`, {});
  expect([blocked.status, blocked.json.error?.code]).toEqual([409, 'launch_blocked']);
  expect(blocked.json.error.details.products).toEqual(['Add at least one active product.']);
  expect(blocked.json.error.details.shipping).toEqual(['Set your delivery charges.']);

  const draftHome = await (await fetch(`${origin}/`)).text();
  expect(draftHome).toContain('Coming soon');

  // 07 → Finish setup with blockers → inline list with links
  await signInDashboard(context, s);
  await page.goto(`${urls.merchant}/onboarding/payments`);
  await page.getByRole('button', { name: 'Finish setup' }).click();
  const alert = page.getByRole('alert', { name: 'Before you go live' });
  await expect(alert).toBeVisible();
  await expect(alert.getByText('Add at least one active product.')).toBeVisible();
  await expect(alert.getByText('Set your delivery charges.')).toBeVisible();
  const phoneBlocked = blocked.json.error.details.contact_phone as string[] | undefined;
  if (phoneBlocked) await expect(alert.getByText(phoneBlocked[0])).toBeVisible();
  expect(await alert.getByRole('link').count()).toBeGreaterThanOrEqual(2);

  // fix: a product (05 via API), a contact phone; then 05 → 06 → 07 in the UI
  const p = await api(s, 'POST', `/stores/${sid}/products`, { name: 'QA Go-live Tee', status: 'active', variants: [{ price_amount: 45000, initial_on_hand: 4 }] });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  expect((await api(s, 'PATCH', `/stores/${sid}/settings`, { contact: { phone: '01700000002' } })).status).toBe(200);
  await page.goto(`${urls.merchant}/onboarding/products`);
  await page.getByRole('button', { name: 'Save & continue' }).click();
  await expect(page).toHaveURL(/\/onboarding\/delivery$/);
  await expect(page.getByLabel('Inside Dhaka charge').or(page.getByLabel(/Inside Dhaka/)).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/onboarding\/payments$/);
  const ship = await api(s, 'GET', `/stores/${sid}/shipping`);
  expect(ship.json.data.configured).toBe(true);
  const zones = ship.json.data.zones as Array<{ kind: string; charge_amount: number; name: string; areas: unknown[] }>;
  expect(zones.find((z) => z.kind === 'fallback')).toMatchObject({ charge_amount: 13000, name: 'Outside Dhaka' });
  expect(zones.find((z) => z.kind === 'custom')).toMatchObject({ charge_amount: 7000, name: 'Inside Dhaka' });
  expect(zones.find((z) => z.kind === 'custom')!.areas).toHaveLength(50);

  await page.getByRole('button', { name: 'Finish setup' }).click();
  const publishedAt = Date.now();
  await expect(page).toHaveURL(/\/onboarding\/live$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /You’re live/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Finish setting up' })).toBeVisible();
  const ms = await waitForStorefrontAt(origin, (b) => !b.includes('Coming soon') && b.includes('QA Go-live Tee'), 10_000);
  expect(Date.now() - publishedAt, `Coming soon disappeared after ${ms} ms`).toBeLessThan(5_000 + 2_000);
  expect(ms).toBeLessThan(5_000);

  const store = await api(s, 'GET', `/stores/${sid}`);
  expect(store.json.data.status).toBe('active');
  const again = await api(s, 'POST', `/stores/${sid}/publish`, {});
  expect(again.status).toBe(200); // idempotent re-publish
  const audit = await api(s, 'GET', `/audit-logs?filter[action]=store.published`);
  if (audit.status === 200) expect((audit.json.data as unknown[]).length).toBeGreaterThanOrEqual(1);
});

async function waitForStorefrontAt(base: string, predicate: (body: string) => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await (await fetch(`${base}/`)).text();
    if (predicate(body)) return Date.now() - started;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${base}/ still shows Coming soon after ${timeoutMs} ms`);
}
