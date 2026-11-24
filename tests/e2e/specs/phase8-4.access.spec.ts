import { expect, test } from '@playwright/test';
import { api, createMember, signInDashboard, unique, urls, type ThrowawayMember } from '../support/api';
import { setPlan, type CommerceShop } from '../support/commerce';
import {
  DEV_PATH,
  addEndpointButton,
  createEndpoint,
  createKey,
  createKeyButton,
  deliveries,
  devShop,
  endpoints,
  external,
  listKeys,
  openDeveloper,
  planNote,
  sinkUrl,
  storefrontOrder,
} from '../support/developer';
import { noAccess, shopOn, watchConsole, type Shop } from '../support/roles';

/**
 * PHASE-8-4 §10 QA `phase8-4.access` (P84-6, P84-13, §7, S105, S106, S109):
 *  - Staff: every developer route 403 (keys, scopes, endpoints, secret reveal, deliveries, dev sink); the page shows the
 *    no-access state; the Integrations list has no "Developer" banner (the owner's has it).
 *  - Free shop: plan note "…part of the Growth plan." + See plans, create buttons disabled, writes 402
 *    `feature_not_in_plan`, reads 200.
 *  - Growth → Free downgrade: nothing deleted; the external API answers 402; endpoint writes 402; a new order creates
 *    no delivery.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const expect402 = (r: { status: number; json: Json }) => {
  expect([r.status, r.json.error?.code], JSON.stringify(r.json)).toEqual([402, 'feature_not_in_plan']);
  expect([r.json.error.details?.upgrade_plan].flat()).toContain('growth');
};

test.describe('staff', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: Shop;
  let staff: ThrowawayMember;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    shop = await shopOn('growth', 'dk-staff');
    staff = await createMember(shop.s, 'staff');
  });
  test.afterAll(async () => {
    await staff?.cleanup();
    shop?.cleanup();
  });

  test('API: staff gets 403 on every developer route (P84-6, S105, S109)', async () => {
    const s = staff.session;
    const sid = shop.s.storeId;
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api-keys'],
      ['POST', '/api-keys', { name: 'x', scopes: ['orders:read'] }],
      ['GET', '/api-scopes'],
      ['GET', '/webhook-event-types'],
      ['GET', `/stores/${sid}/webhook-endpoints`],
      ['POST', `/stores/${sid}/webhook-endpoints`, { url: sinkUrl('staff'), events: ['order.created'] }],
      ['GET', `/stores/${sid}/webhook-secret`],
      ['POST', `/stores/${sid}/webhook-secret/reveal`, {}],
      ['POST', `/stores/${sid}/webhook-secret/rotate`, {}],
      ['GET', `/stores/${sid}/webhook-deliveries`],
      ['POST', `/stores/${sid}/webhook-deliveries/resend-failed`, {}],
      ['GET', '/dev/webhook-sink'],
    ];
    const got: string[] = [];
    for (const [m, p, b] of calls) got.push(`${m} ${p} → ${(await api(s, m, p, b)).status}`);
    expect(got).toEqual(calls.map(([m, p]) => `${m} ${p} → 403`));
    // The owner's membership carries the permission, staff's doesn't.
    const me = await api(s, 'GET', '/auth/me');
    const mine = (me.json.data.tenants as Json[]).find((t) => t.id === shop.s.tenantId)!;
    expect(mine.permissions).not.toContain('developers.manage');
  });

  test('UI: staff sees the no-access state and no Developer banner; the owner sees the banner', async ({ browser }) => {
    test.setTimeout(90_000);
    const sc = await browser.newContext();
    const page = await sc.newPage();
    const c = watchConsole(page);
    await signInDashboard(sc, staff.session);
    await page.goto(`${urls.merchant}${DEV_PATH}`);
    await expect(noAccess(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /Create API key/ })).toHaveCount(0);
    await page.goto(`${urls.merchant}/integrations`);
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
    await expect(page.locator(`a[href$="${DEV_PATH}"]`)).toHaveCount(0);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
    await sc.close();

    const oc = await browser.newContext();
    const owner = await oc.newPage();
    await signInDashboard(oc, shop.s);
    await owner.goto(`${urls.merchant}/integrations`);
    const banner = owner.locator(`a[href$="${DEV_PATH}"]`).first();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Developer/);
    await banner.click();
    await expect(owner).toHaveURL(new RegExp(`${DEV_PATH}$`));
    await expect(owner.getByRole('heading', { name: /Developer/, level: 1 })).toBeVisible();
    await oc.close();
  });
});

test.describe('Free shop', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: Shop;
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    shop = await shopOn('free', 'dk-free');
  });
  test.afterAll(() => shop?.cleanup());

  test('API: reads 200, writes 402 feature_not_in_plan (S106)', async () => {
    expect((await api(shop.s, 'GET', '/api-keys')).status).toBe(200);
    expect((await api(shop.s, 'GET', `/stores/${shop.s.storeId}/webhook-endpoints`)).status).toBe(200);
    expect((await api(shop.s, 'GET', '/api-scopes')).status).toBe(200);
    expect402(await api(shop.s, 'POST', '/api-keys', { name: 'Free key', scopes: ['orders:read'] }));
    expect402(await api(shop.s, 'POST', `/stores/${shop.s.storeId}/webhook-endpoints`, { url: sinkUrl('free'), events: ['order.created'] }));
  });

  test('UI: plan note + See plans, create buttons disabled', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    await openDeveloper(page);
    const note = planNote(page);
    await expect(note).toContainText('API keys and webhooks are part of the Growth plan.');
    await expect(note.getByRole('link', { name: /See plans/ })).toHaveAttribute('href', /\/settings\/plan/);
    await expect(createKeyButton(page)).toBeDisabled();
    await expect(addEndpointButton(page)).toBeDisabled();
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});

test.describe('Growth shop downgraded to Free (P84-13)', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: CommerceShop;
  let plain: string;
  let keyId: string;
  let endpointId: string;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    shop = await devShop('dk-down');
    const k = await createKey(shop.s, 'Downgrade key', ['orders:read']);
    plain = k.plain;
    keyId = k.key.id as string;
    expect((await external(plain, 'GET', '/me')).status).toBe(200);
    endpointId = (await createEndpoint(shop.s, sinkUrl(unique('dn-')), ['order.created'])).id as string;
    setPlan(shop.s, 'free');
  });
  test.afterAll(() => shop?.cleanup());

  test('external 402, writes 402, nothing deleted, no new deliveries', async () => {
    test.setTimeout(90_000);
    const me = await external(plain, 'GET', '/me');
    expect402(me);
    expect402(await external(plain, 'GET', `/stores/${shop.s.storeId}/orders`));
    expect((await listKeys(shop.s)).find((k) => k.id === keyId)).toMatchObject({ status: 'active' });
    expect((await endpoints(shop.s)).map((e) => e.id)).toContain(endpointId);
    expect402(await api(shop.s, 'PATCH', `/stores/${shop.s.storeId}/webhook-endpoints/${endpointId}`, { description: 'x' }));
    expect402(await api(shop.s, 'POST', '/api-keys', { name: 'Another', scopes: ['orders:read'] }));

    await storefrontOrder(shop);
    // Events are dropped, not queued: give a worker time, then expect nothing.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await deliveries(shop.s, `filter[endpoint_id]=${endpointId}`)).toEqual([]);
  });
});
