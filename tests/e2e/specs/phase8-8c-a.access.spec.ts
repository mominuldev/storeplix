import { expect, test } from '@playwright/test';
import { apiCall, createMember, signInDashboard, type Session, type ThrowawayMember } from '../support/api';
import { setPlan, type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import {
  adjust,
  adjustRaw,
  createLocation,
  createLocationRaw,
  defaultLocation,
  DHANMONDI,
  locationActionRaw,
  locations,
  locationsRaw,
  openWarehouses,
  patchLocationRaw,
  stockAt,
  UPGRADE_NOTE,
  addLocationButton,
} from '../support/locations';
import { createPoRaw, createSupplier, purchasingShop, retryLocked, spath } from '../support/purchasing';

/**
 * PHASE-8-8C §12 part A at the HTTP edge (S179 isolation, S180 permissions, S181 plan + downgrade, P88C-17 archive
 * rules, §4 name rule). Two Growth shops (A, B); system Staff in A.
 *  - S179: B's location id in A's adjust / PO / inventory filter / location routes → 404 or 422, nothing written;
 *    A's location through B's session → 404.
 *  - S180: Staff reads locations (200) but every location write → 403 `forbidden`; Staff may adjust at a location
 *    (`inventory.adjust`).
 *  - §4 / P88C-17: duplicate name (case-insensitive) → 422 `location_name_taken`; archive the default or a location
 *    with stock → 409 `location_in_use`; make an archived location default → 409.
 *  - S181: downgrade A to Starter → reads, adjust at Dhanmondi and archive-once-empty still work; a new location and
 *    unarchive → 402 `feature_not_in_plan`; the Warehouses tab shows the upgrade note and no "+ Add location".
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let a: CommerceShop;
let b: CommerceShop;
let staff: ThrowawayMember | undefined;
let dhan: Json;
let bLoc: Json;
const asStaff = (): Session => ({ ...staff!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  a = await purchasingShop('lxa', 'growth', 4);
  b = await purchasingShop('lxb', 'growth', 4);
  dhan = await createLocation(a.s, DHANMONDI);
  bLoc = await createLocation(b.s, 'Chattogram hub', { type: 'warehouse' });
  staff = await createMember(a.s, 'staff');
});
test.afterAll(async () => {
  await staff?.cleanup();
  a?.cleanup();
  b?.cleanup();
});

test('S179: another store\'s location is never usable; another tenant can\'t see ours', async () => {
  const sv = a.simple.variantId;
  const before = await stockAt(a.s, sv, (await defaultLocation(a.s)).id);

  const adj = await adjustRaw(a.s, [{ variant_id: sv, quantity: 2, location_id: bLoc.id }]);
  expect([404, 422], `adjust with B's location: ${adj.text.slice(0, 200)}`).toContain(adj.status);
  expect(await stockAt(a.s, sv, (await defaultLocation(a.s)).id)).toEqual(before);

  const sup = await createSupplier(a.s);
  const po = await createPoRaw(a.s, { supplier_id: sup.id, location_id: bLoc.id, lines: [{ variant_id: sv, unit_cost_amount: 100, quantity: 1 }] });
  expect([404, 422], `PO with B's location: ${po.text.slice(0, 200)}`).toContain(po.status);

  const filt = await retryLocked(() => apiCall(a.s, 'GET', spath(a.s, `/inventory?filter[location_id]=${bLoc.id}`)));
  expect([404, 422], `inventory filter with B's location: ${filt.text.slice(0, 200)}`).toContain(filt.status);

  for (const [method, path, body] of [
    ['PATCH', `/locations/${bLoc.id}`, { name: 'hijack' }],
    ['POST', `/locations/${bLoc.id}/make-default`, {}],
    ['POST', `/locations/${bLoc.id}/archive`, {}],
  ] as const) {
    const r = await retryLocked(() => apiCall(a.s, method, spath(a.s, path), { json: body }));
    expect(r.status, `${method} ${path} on A: ${r.text.slice(0, 200)}`).toBe(404);
  }
  // A's location through B's session (B's store path) → 404; A's store path with B's tenant → 404
  const viaB = await retryLocked(() => apiCall(b.s, 'PATCH', spath(b.s, `/locations/${dhan.id}`), { json: { name: 'x' } }));
  expect(viaB.status).toBe(404);
  const crossStore = await locationsRaw(a.s, '', b.s);
  expect(crossStore.status).toBe(404);
  expect((await locations(b.s)).map((l) => l.name)).not.toContain(DHANMONDI);
});

test('S180: Staff reads locations but cannot write them; Staff adjusts at a location', async () => {
  const st = asStaff();
  expect((await locationsRaw(a.s, '', st)).status).toBe(200);
  const denied: Array<[string, Promise<{ status: number; json: Json }>]> = [
    ['create', createLocationRaw(a.s, { name: 'Staff shop', type: 'shop' }, st)],
    ['patch', patchLocationRaw(a.s, dhan.id, { name: 'Renamed' }, st)],
    ['make-default', locationActionRaw(a.s, dhan.id, 'make-default', st)],
    ['archive', locationActionRaw(a.s, dhan.id, 'archive', st)],
  ];
  for (const [what, p] of denied) {
    const r = await p;
    expect([r.status, r.json.error?.code], `staff ${what}`).toEqual([403, 'forbidden']);
  }
  const ok = await adjustRaw(a.s, [{ variant_id: a.simple.variantId, quantity: 2, location_id: dhan.id }], 'received', st);
  expect(ok.status, ok.text.slice(0, 200)).toBe(200);
  expect(await stockAt(a.s, a.simple.variantId, dhan.id)).toMatchObject({ on_hand: 2 });
  expect((await locations(a.s)).map((l) => l.name)).toEqual(['Main warehouse', DHANMONDI]);
});

test('§4 / P88C-17: name taken, archive rules, archived can\'t become default', async () => {
  const dup = await createLocationRaw(a.s, { name: 'dhanmondi SHOP', type: 'shop' });
  expect([dup.status, dup.json.error?.code], dup.text.slice(0, 200)).toEqual([422, 'location_name_taken']);

  const main = await defaultLocation(a.s);
  const archDefault = await locationActionRaw(a.s, main.id, 'archive');
  expect([archDefault.status, archDefault.json.error?.code], archDefault.text.slice(0, 200)).toEqual([409, 'location_in_use']);
  const archStock = await locationActionRaw(a.s, dhan.id, 'archive');
  expect([archStock.status, archStock.json.error?.code], archStock.text.slice(0, 200)).toEqual([409, 'location_in_use']);

  const spare = await createLocation(a.s, 'QA Spare godown', { type: 'warehouse' });
  const arch = await locationActionRaw(a.s, spare.id, 'archive');
  expect(arch.status, arch.text.slice(0, 200)).toBe(200);
  // §4 says 409; openapi 1.18.0 (machine-readable, binding for shapes) documents 422 `location_archived` for any
  // reference to an archived location incl. make-default — the API follows openapi (QA report: contract wording).
  const mk = await locationActionRaw(a.s, spare.id, 'make-default');
  expect([mk.status, mk.json.error?.code], mk.text.slice(0, 200)).toEqual([422, 'location_archived']);
  expect((await defaultLocation(a.s)).id).toBe(main.id);
});

test('S181: after a downgrade to Starter, reads/adjust/archive work; new location and unarchive → 402', async ({ page, context }) => {
  test.setTimeout(90_000);
  setPlan(a.s, 'starter');
  expect((await locations(a.s)).map((l) => l.name)).toEqual(['Main warehouse', DHANMONDI]);
  await adjust(a.s, [{ variant_id: a.simple.variantId, quantity: 1, location_id: dhan.id }]);
  expect(await stockAt(a.s, a.simple.variantId, dhan.id)).toMatchObject({ on_hand: 3 });

  const create = await createLocationRaw(a.s, { name: 'QA Third', type: 'shop' });
  expect([create.status, create.json.error?.code], create.text.slice(0, 200)).toEqual([402, 'feature_not_in_plan']);
  const spare = (await (await locationsRaw(a.s, 'filter[archived]=1')).json.data as Json[]).find((l) => l.name === 'QA Spare godown')
    ?? ((await locationsRaw(a.s)).json.data as Json[]).find((l) => l.name === 'QA Spare godown');
  expect(spare, 'archived location still listed (filter[archived] or inline)').toBeTruthy();
  const un = await locationActionRaw(a.s, spare!.id, 'unarchive');
  expect([un.status, un.json.error?.code], un.text.slice(0, 200)).toEqual([402, 'feature_not_in_plan']);

  // archive once empty
  await adjust(a.s, [{ variant_id: a.simple.variantId, mode: 'set', quantity: 0, location_id: dhan.id }], 'correction');
  const arch = await locationActionRaw(a.s, dhan.id, 'archive');
  expect(arch.status, arch.text.slice(0, 200)).toBe(200);
  expect((await locations(a.s)).map((l) => l.name)).toEqual(['Main warehouse']);

  const c = watchConsole(page);
  await signInDashboard(context, a.s);
  await openWarehouses(page);
  await expect(page.getByText(UPGRADE_NOTE).first()).toBeVisible();
  await expect(addLocationButton(page).and(page.locator(':enabled')), '"+ Add location" not offered without multi_warehouse').toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
