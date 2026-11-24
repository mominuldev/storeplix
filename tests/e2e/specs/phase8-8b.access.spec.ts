import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiCall, createMember, signInDashboard, type Session, type ThrowawayMember } from '../support/api';
import { setPlan, type CommerceShop } from '../support/commerce';
import { createRole, myMembership, noAccess, watchConsole } from '../support/roles';
import {
  createPo,
  createSupplier,
  inventoryTab,
  landedUnitCosts,
  lineFor,
  moneyLeaks,
  moneyOnScreen,
  mUrl,
  openPo,
  openPoList,
  openSuppliers,
  PLAN_NOTE,
  po,
  poList,
  purchasingShop,
  quickRaw,
  receiveAllRemaining,
  receiveRaw,
  receiveUnits,
  sendPo,
  SUPPLIERS,
  today,
  variantOf,
  weightedCost,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA access + plan (P88B-11, P88B-12, §2, §8.1; S168, S169, S178):
 *  - owner holds `purchasing.manage`; system Staff does not → 403 `forbidden` on every supplier / PO money route;
 *  - a custom role with ONLY `inventory.adjust` lists and opens POs and receives, with every money/cost field null and
 *    sent costs ignored (the owner sees the cost computed from the PO's landed cost); its dashboard shows the
 *    Purchase orders tab but not Suppliers, the PO page shows no ৳ figure, and "Receive all remaining" works;
 *  - Free shop: reads 200, every purchasing write 402 `feature_not_in_plan`; the pages show the plan note.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let staff: ThrowawayMember | undefined;
let receiver: ThrowawayMember | undefined;
let sup: Json;
let ordered: Json;
let uiPo: Json;

const asMember = (m: ThrowawayMember): Session => ({ ...m.session, storeId: shop.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  shop = await purchasingShop('pox', 'growth', 10);
  sup = await createSupplier(shop.s);
  const draft = await createPo(shop.s, sup.id, [
    { variant_id: shop.simple.variantId, unit_cost_amount: 22_000, quantity: 4 },
    { variant_id: shop.variable.variants[1].id, unit_cost_amount: 90_000, quantity: 2 },
  ], { shipping_amount: 2_000 });
  ordered = await sendPo(shop.s, draft.id, 'manual');
  uiPo = await sendPo(shop.s, (await createPo(shop.s, sup.id, [{ variant_id: shop.simple.variantId, unit_cost_amount: 21_000, quantity: 3 }])).id, 'whatsapp');
  staff = await createMember(shop.s, 'staff');
  const role = await createRole(shop.s, 'QA Stock receiver', ['inventory.adjust']);
  receiver = await createMember(shop.s, { role_id: role.id as string });
});
test.afterAll(async () => {
  await staff?.cleanup();
  await receiver?.cleanup();
  shop?.cleanup();
});

/** Every §8.1 route that needs `purchasing.manage` (receipts + PO reads excluded: `inventory.adjust` is enough). */
function managedRoutes(): Array<[string, string, Json | undefined]> {
  const b = `/stores/${shop.s.storeId}`;
  return [
    ['GET', `${b}/suppliers`, undefined],
    ['GET', `${b}/suppliers/summary`, undefined],
    ['POST', `${b}/suppliers`, { name: 'QA denied' }],
    ['GET', `${b}/suppliers/${sup.id}`, undefined],
    ['PATCH', `${b}/suppliers/${sup.id}`, { city: 'Khulna' }],
    ['POST', `${b}/suppliers/${sup.id}/archive`, {}],
    ['DELETE', `${b}/suppliers/${sup.id}`, undefined],
    ['GET', `${b}/suppliers/${sup.id}/payments`, undefined],
    ['POST', `${b}/suppliers/${sup.id}/payments`, { amount: 100, method: 'cash', paid_on: today() }],
    ['GET', `${b}/purchase-orders/summary`, undefined],
    ['POST', `${b}/purchase-orders`, { supplier_id: sup.id, lines: [{ variant_id: shop.simple.variantId, unit_cost_amount: 1, quantity: 1 }] }],
    ['POST', `${b}/purchase-orders/quick`, { supplier_id: sup.id, lines: [{ variant_id: shop.simple.variantId, unit_cost_amount: 1, quantity: 1 }] }],
    ['PATCH', `${b}/purchase-orders/${ordered.id}`, { notes: 'x', revision: ordered.revision }],
    ['POST', `${b}/purchase-orders/${ordered.id}/close`, {}],
    ['POST', `${b}/purchase-orders/${ordered.id}/cancel`, {}],
    ['GET', `${b}/purchase-orders/${ordered.id}/pdf`, undefined],
    ['GET', `${b}/purchasing/reorder-suggestions`, undefined],
  ];
}

test('owner has purchasing.manage; staff gets 403 on every money route, nothing changes (S168)', async () => {
  expect((await myMembership(shop.s)).permissions ?? []).toContain('purchasing.manage');
  const st = asMember(staff!);
  expect((await myMembership(st)).permissions ?? []).not.toContain('purchasing.manage');
  for (const [method, path, json] of managedRoutes()) {
    const headers = path.endsWith('/quick') ? { 'Idempotency-Key': randomUUID() } : undefined;
    const r = await apiCall(st, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) });
    expect([r.status, r.json.error?.code], `${method} ${path}`).toEqual([403, 'forbidden']);
  }
  expect(await po(shop.s, ordered.id)).toMatchObject({ status: 'ordered', notes: null });
});

test('inventory.adjust only: lists, opens and receives with every money field null; sent costs ignored (S168, P88B-11)', async () => {
  const rc = asMember(receiver!);
  const perms = (await myMembership(rc)).permissions ?? [];
  expect(perms).toContain('inventory.adjust');
  expect(perms).not.toContain('purchasing.manage');
  for (const [method, path, json] of managedRoutes()) {
    const headers = path.endsWith('/quick') ? { 'Idempotency-Key': randomUUID() } : undefined;
    const r = await apiCall(rc, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) });
    expect([r.status, r.json.error?.code], `${method} ${path}`).toEqual([403, 'forbidden']);
  }

  const list = await poList(shop.s, '', rc);
  expect(list.data.map((x) => x.id)).toContain(ordered.id);
  expect(moneyLeaks(list.data), 'list money null').toEqual([]);
  expect(list.data.find((x) => x.id === ordered.id)!.payment_status).toBeNull();
  const detail = await po(shop.s, ordered.id, rc);
  expect(moneyLeaks(detail), 'detail money null').toEqual([]);
  expect(detail.payments).toEqual([]);
  expect(lineFor(detail, shop.simple.variantId)).toMatchObject({ quantity_ordered: 4, quantity_left: 4, unit_cost_amount: null, landed_unit_cost_amount: null, last_bought_unit_cost_amount: null });

  const before = await variantOf(shop.s, shop.simple.id, shop.simple.variantId);
  const lines = [{ item_id: lineFor(detail, shop.simple.variantId).id, received: 3, damaged: 0, unit_cost_amount: 1, landed_unit_cost_amount: 1, cost_after_amount: 1 }];
  const r = await receiveRaw(shop.s, ordered.id, lines, randomUUID(), { value_amount: 1 }, rc);
  expect(r.status, r.text.slice(0, 300)).toBe(201);
  expect(moneyLeaks(r.json.data), 'receipt answer money null').toEqual([]);
  expect(r.json.data.receipts[0].received_by?.name ?? '').toBeTruthy();

  // the owner sees the cost from the PO's landed cost, never from the sent values
  const [landed] = landedUnitCosts([{ unit: 22_000, qty: 4 }, { unit: 90_000, qty: 2 }], 2_000, 0);
  const after = await variantOf(shop.s, shop.simple.id, shop.simple.variantId);
  expect(after.inventory.on_hand).toBe(before.inventory.on_hand + 3);
  expect(after.cost_amount).toBe(weightedCost(before.inventory.on_hand, before.cost_amount, 3, landed));
  const owner = await po(shop.s, ordered.id);
  expect(owner.receipts[0].value_amount).toBe(3 * landed);
  expect(owner.receipts[0].lines[0].landed_unit_cost_amount).toBe(landed);
});

test('UI inventory.adjust only: Purchase orders tab yes, Suppliers no; receive without any price on screen', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  const rc = asMember(receiver!);
  await signInDashboard(context, rc);
  await openPoList(page);
  await expect(inventoryTab(page, 'Suppliers')).toHaveCount(0);
  const main = page.getByRole('main');
  expect(await moneyOnScreen(main), 'PO list shows no money').toEqual([]);

  await openPo(page, uiPo.id, uiPo.number);
  await expect(page.getByRole('button', { name: /^Record payment$/ })).toHaveCount(0);
  await expect(page.getByText(/^(Total|Paid|Due)$/)).toHaveCount(0);
  expect(await moneyOnScreen(main), 'PO detail shows no money').toEqual([]);
  await receiveAllRemaining(page).click();
  await expect(receiveUnits(page)).toHaveText(/Receive 3 units/);
  await expect(page.getByText(/Stock value \+/)).toHaveCount(0);
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/receipts$/.test(new URL(r.url()).pathname));
  await receiveUnits(page).click();
  expect((await posted).status()).toBe(201);
  await expect(page.getByText(/^Received$/).first()).toBeVisible();
  expect(await moneyOnScreen(main), 'after receiving: still no money').toEqual([]);

  await page.goto(mUrl(SUPPLIERS));
  await expect(noAccess(page)).toBeVisible({ timeout: 15_000 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test.describe('Free shop (S169, P88B-12)', () => {
  let free: CommerceShop;
  let fsup: Json;
  let fdraft: Json;
  let fordered: Json;
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    free = await purchasingShop('pofr', 'growth', 5);
    fsup = await createSupplier(free.s);
    fdraft = await createPo(free.s, fsup.id, [{ variant_id: free.simple.variantId, unit_cost_amount: 10_000, quantity: 2 }]);
    fordered = await sendPo(free.s, (await createPo(free.s, fsup.id, [{ variant_id: free.simple.variantId, unit_cost_amount: 10_000, quantity: 2 }])).id, 'manual');
    setPlan(free.s, 'free');
  });
  test.afterAll(() => free?.cleanup());

  test('reads 200; every purchasing write 402 feature_not_in_plan', async () => {
    const b = `/stores/${free.s.storeId}`;
    for (const path of ['/suppliers', '/suppliers/summary', `/suppliers/${fsup.id}`, '/purchase-orders', '/purchase-orders/summary', `/purchase-orders/${fdraft.id}`, '/purchasing/reorder-suggestions']) {
      const r = await apiCall(free.s, 'GET', `${b}${path}`);
      expect(r.status, `GET ${path}: ${r.text.slice(0, 200)}`).toBe(200);
    }
    const writes: Array<[string, string, Json, Record<string, string>?]> = [
      ['POST', `${b}/suppliers`, { name: 'QA Free supplier' }],
      ['PATCH', `${b}/suppliers/${fsup.id}`, { city: 'Sylhet' }],
      ['POST', `${b}/suppliers/${fsup.id}/payments`, { amount: 1_000, method: 'cash', paid_on: today() }],
      ['POST', `${b}/purchase-orders`, { supplier_id: fsup.id, lines: [{ variant_id: free.simple.variantId, unit_cost_amount: 1_000, quantity: 1 }] }],
      ['PATCH', `${b}/purchase-orders/${fdraft.id}`, { notes: 'x', revision: fdraft.revision }],
      ['POST', `${b}/purchase-orders/${fdraft.id}/send`, { sent_via: 'pdf' }],
      ['POST', `${b}/purchase-orders/${fordered.id}/receipts`, { lines: [{ item_id: fordered.lines[0].id, received: 1, damaged: 0 }] }, { 'Idempotency-Key': randomUUID() }],
    ];
    for (const [method, path, json, headers] of writes) {
      const r = await apiCall(free.s, method, path, { json, ...(headers ? { headers } : {}) });
      expect([r.status, r.json.error?.code], `${method} ${path}: ${r.text.slice(0, 200)}`).toEqual([402, 'feature_not_in_plan']);
    }
    const q = await quickRaw(free.s, { supplier_id: fsup.id, lines: [{ variant_id: free.simple.variantId, unit_cost_amount: 1_000, quantity: 1 }] });
    expect([q.status, q.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect((await variantOf(free.s, free.simple.id, free.simple.variantId)).inventory.on_hand).toBe(5);
  });

  test('UI: PO list and Suppliers show the plan note with "See plans"', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, free.s);
    for (const open of [openPoList, openSuppliers]) {
      await open(page);
      await expect(page.getByText(PLAN_NOTE).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('link', { name: /See plans/ }).or(page.getByRole('button', { name: /See plans/ })).first()).toBeVisible();
    }
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});
