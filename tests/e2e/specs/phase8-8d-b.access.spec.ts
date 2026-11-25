import { expect, test } from '@playwright/test';
import { createMember, type Session, type ThrowawayMember } from '../support/api';
import { setPlan } from '../support/commerce';
import { createRole } from '../support/roles';
import {
  cashSale,
  heldDeleteRaw,
  heldGetRaw,
  heldListRaw,
  holdRaw,
  openSession,
  posShop,
  returnByVariant,
  returnRaw,
  saleGetRaw,
  salesListRaw,
  type PosShop,
} from '../support/pos';

/**
 * PHASE-8-8D part B access (§2, §10 part B rows; S195, S196, S197, S206, S207):
 *  - S195: A's held sale / sale returns through B's path → 404; B's register in A's held list, B's session in A's
 *    return, another sale's order item → 422.
 *  - S196: no `pos.sell` → 403 on held sales, history and returns; `pos.sell` without `orders.refund` → 403 on
 *    returns only.
 *  - S197: after a Growth → Starter downgrade: hold and return → 402 (`orders.refund` is checked first, so a role
 *    without it still gets 403); history, sale detail and the held list stay readable; delete of a held sale works.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let a: PosShop;
let b: PosShop;
let aSess: Json;
let bSess: Json;
let aSale: Json;
let aSale2: Json;
let aHeld: Json;
let viewer: ThrowawayMember | undefined;
let cashier: ThrowawayMember | undefined;
const as = (m: ThrowawayMember | undefined): Session => ({ ...m!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  a = await posShop('pba', 'growth');
  b = await posShop('pbb', 'growth');
  aSess = await openSession(a.s, a.register.id, { opening_cash_amount: 100000 });
  bSess = await openSession(b.s, b.register.id, { opening_cash_amount: 100000 });
  aSale = await cashSale(a.s, aSess.id, [{ variant_id: a.wrap, quantity: 2 }]);
  aSale2 = await cashSale(a.s, aSess.id, [{ variant_id: a.kurtaM, quantity: 1 }]);
  const h = await holdRaw(a.s, { session_id: aSess.id, lines: [{ variant_id: a.wrap, quantity: 1 }] });
  expect(h.status).toBe(201);
  aHeld = h.json.data;
  viewer = await createMember(a.s, { role_id: (await createRole(a.s, 'QA Orders viewer B', ['orders.view'])).id as string });
  cashier = await createMember(a.s, { role_id: (await createRole(a.s, 'QA Cashier B', ['pos.sell'])).id as string });
});
test.afterAll(async () => {
  a?.cleanup();
  b?.cleanup();
  for (const m of [viewer, cashier]) await m?.cleanup().catch(() => undefined);
});

test('S195: cross-tenant/store → 404; foreign ids in bodies and queries → 422', async () => {
  for (const [what, p] of [
    ['held via B path', heldGetRaw(b.s, aHeld.id)],
    ['delete held via B path', heldDeleteRaw(b.s, aHeld.id)],
    ['held as B session', heldGetRaw(a.s, aHeld.id, b.s)],
    ['return via B path', returnRaw(b.s, aSale.id, { session_id: bSess.id, lines: [{ order_item_id: aSale.id, quantity: 1 }], refund_method: 'card' })],
    ['sale detail via B path', saleGetRaw(b.s, aSale.id)],
  ] as const)
    expect([what, (await p).status]).toEqual([what, 404]);
  expect((await heldGetRaw(a.s, aHeld.id)).status, 'nothing deleted').toBe(200);

  const list = await heldListRaw(a.s, b.register.id);
  expect([list.status, Object.keys(list.json.error?.details ?? {})]).toEqual([422, ['register_id']]);
  const hist = await salesListRaw(a.s, `filter[register_id]=${b.register.id}`);
  expect(hist.status, 'foreign register in the history filter').toBe(422);
  const holdB = await holdRaw(a.s, { session_id: bSess.id, lines: [{ variant_id: a.wrap, quantity: 1 }] });
  expect([holdB.status, Object.keys(holdB.json.error?.details ?? {})]).toEqual([422, ['session_id']]);
  const holdVar = await holdRaw(a.s, { session_id: aSess.id, lines: [{ variant_id: b.wrap, quantity: 1 }] });
  expect(holdVar.status).toBe(422);
  const retB = await returnByVariant(a.s, aSale, bSess.id, [[a.wrap, 1]], 'card');
  expect([retB.status, Object.keys(retB.json.error?.details ?? {})]).toEqual([422, ['session_id']]);
  // An order item of another sale of the same store.
  const other = (await saleGetRaw(a.s, aSale2.id)).json.data.order.items[0].id as string;
  const mixed = await returnRaw(a.s, aSale.id, { session_id: aSess.id, lines: [{ order_item_id: other, quantity: 1 }], refund_method: 'card' });
  expect([mixed.status, Object.keys(mixed.json.error?.details ?? {}).join(',')]).toEqual([422, 'lines.0.order_item_id']);
});

test('S196: no pos.sell → 403 on held/history/returns; pos.sell without orders.refund → 403 on returns only', async () => {
  const v = as(viewer);
  for (const [what, p] of [
    ['held list', heldListRaw(a.s, a.register.id, v)],
    ['hold', holdRaw(a.s, { session_id: aSess.id, lines: [{ variant_id: a.wrap, quantity: 1 }] }, v)],
    ['held get', heldGetRaw(a.s, aHeld.id, v)],
    ['held delete', heldDeleteRaw(a.s, aHeld.id, v)],
    ['history', salesListRaw(a.s, '', v)],
    ['return', returnByVariant(a.s, aSale, aSess.id, [[a.wrap, 1]], 'card', {}, v)],
  ] as const) {
    const r = await p;
    expect([what, r.status, r.json.error?.code]).toEqual([what, 403, 'forbidden']);
  }
  const cs = as(cashier);
  expect((await heldListRaw(a.s, a.register.id, cs)).status).toBe(200);
  expect((await salesListRaw(a.s, '', cs)).status).toBe(200);
  const ret = await returnByVariant(cs, aSale, aSess.id, [[a.wrap, 1]], 'card');
  expect([ret.status, ret.json.error?.code]).toEqual([403, 'forbidden']);
});

test('S197: downgrade → hold and return 402 (403 first without orders.refund); reads and held delete still work', async () => {
  setPlan(a.s, 'starter');
  try {
    const hold = await holdRaw(a.s, { session_id: aSess.id, lines: [{ variant_id: a.wrap, quantity: 1 }] });
    expect([hold.status, hold.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const ret = await returnByVariant(a.s, aSale2, aSess.id, [[a.kurtaM, 1]], 'card');
    expect([ret.status, ret.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const cret = await returnByVariant(as(cashier), aSale2, aSess.id, [[a.kurtaM, 1]], 'card');
    expect([cret.status, cret.json.error?.code], 'orders.refund is checked before the plan').toEqual([403, 'forbidden']);
    expect((await salesListRaw(a.s)).status).toBe(200);
    expect((await saleGetRaw(a.s, aSale.id)).status).toBe(200);
    expect((await heldListRaw(a.s, a.register.id)).status).toBe(200);
    expect((await heldDeleteRaw(a.s, aHeld.id)).status).toBeLessThan(300);
  } finally {
    setPlan(a.s, 'growth');
  }
});
