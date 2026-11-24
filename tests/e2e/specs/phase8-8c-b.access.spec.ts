import { expect, test } from '@playwright/test';
import { createMember, signInDashboard, type Session, type ThrowawayMember } from '../support/api';
import { setPlan, type CommerceShop } from '../support/commerce';
import { createRole, watchConsole } from '../support/roles';
import { createLocation, defaultLocation, DHANMONDI, mUrl, stockAt } from '../support/locations';
import { purchasingShop } from '../support/purchasing';
import {
  count,
  countActionRaw,
  countLineOf,
  countLinesRaw,
  countRaw,
  createTransfer,
  createTransferRaw,
  inventoryTab,
  newTransferButton,
  openCounts,
  openTransfer,
  openTransfers,
  panel,
  scanRaw,
  sendTransfer,
  setCountedRaw,
  SKU_BOX,
  startCount,
  startCountButton,
  startCountRaw,
  transfer,
  transferActionRaw,
  transferRaw,
  transferRow,
  transfersRaw,
  transferStockButton,
  TRANSFER_PLAN_NOTE,
} from '../support/transfers';

/**
 * PHASE-8-8C §12 part B at the HTTP edge + UI gating (S187, S191, S192, P88C-13/14, §10):
 *  - Starter one-location shop: no "Transfer stock" on Inventory; the Transfers tab is hidden or shows the plan note
 *    without "+ New transfer"; POST stock-transfers → 402 `feature_not_in_plan`; Stock count works (201).
 *  - S187: Growth shops A and B: A's transfer / count / count line through B → 404; B's location in A's transfer → 404/422.
 *  - P88C-14: a custom role without `inventory.adjust` (orders.view only) reads Transfers + the count (200) but every
 *    write → 403 `forbidden`; UI read-only (no "+ New transfer", no "Start count", no SKU box, no Send/Receive).
 *  - S191: a custom role with `inventory.adjust` but not `costs.view` counts, but the summary values are null and the
 *    VALUE column / money is not shown.
 *  - S192: A downgraded to Starter with an in-transit transfer → receive 200 and a second in-transit transfer cancel
 *    200; new transfer create / send of a draft → 402.
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let starter: CommerceShop;
let a: CommerceShop;
let b: CommerceShop;
let viewer: ThrowawayMember | undefined;
let counter: ThrowawayMember | undefined;
let aMain: Json;
let aDhan: Json;
let bLoc: Json;
let aCount: Json;
const as = (m: ThrowawayMember | undefined): Session => ({ ...m!.session, storeId: a.s.storeId });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  starter = await purchasingShop('tas', 'starter', 4);
  a = await purchasingShop('taa', 'growth', 6);
  b = await purchasingShop('tab', 'growth', 4);
  aMain = await defaultLocation(a.s);
  aDhan = await createLocation(a.s, DHANMONDI);
  bLoc = await createLocation(b.s, 'Chattogram hub', { type: 'warehouse' });
  const ro = await createRole(a.s, 'QA Stock viewer', ['orders.view']);
  viewer = await createMember(a.s, { role_id: ro.id as string });
  const cr = await createRole(a.s, 'QA Counter', ['inventory.adjust']);
  counter = await createMember(a.s, { role_id: cr.id as string });
});
test.afterAll(async () => {
  await viewer?.cleanup();
  await counter?.cleanup();
  starter?.cleanup();
  a?.cleanup();
  b?.cleanup();
});

test('Starter: no Transfer stock, plan note, 402 on create; Stock count still works', async ({ page, context }) => {
  test.setTimeout(90_000);
  const main = await defaultLocation(starter.s);
  const r = await createTransferRaw(starter.s, { from_location_id: main.id, to_location_id: main.id, lines: [{ variant_id: starter.simple.variantId, quantity: 1 }] });
  expect([r.status, r.json.error?.code], r.text.slice(0, 200)).toEqual([402, 'feature_not_in_plan']);

  const c = watchConsole(page);
  await signInDashboard(context, starter.s);
  await page.goto(mUrl('/inventory'));
  await expect(page.getByText('QA Muslin Wrap').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  await expect(transferStockButton(page), 'no Transfer stock on Starter').toHaveCount(0);
  await expect(inventoryTab(page, 'Stock count'), 'Stock count on every plan').toBeVisible();

  const tab = inventoryTab(page, 'Transfers');
  if ((await tab.count()) > 0) {
    await openTransfers(page);
    await expect(page.getByText(TRANSFER_PLAN_NOTE).first(), 'plan note on Transfers').toBeVisible();
    await expect(newTransferButton(page).and(page.locator(':enabled'))).toHaveCount(0);
  } else {
    test.info().annotations.push({ type: 'transfers-tab', description: 'Transfers tab hidden on Starter (one location)' });
  }

  const cnt = await startCountRaw(starter.s, { location_id: main.id });
  expect(cnt.status, cnt.text.slice(0, 200)).toBe(201);
  expect((await countActionRaw(starter.s, cnt.json.data.id, 'cancel')).status).toBe(200);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S187: transfers, counts and count lines of another tenant/store → 404', async () => {
  const t = await createTransfer(a.s, aMain.id, aDhan.id, [{ variant_id: a.simple.variantId, quantity: 1 }]);
  aCount = await startCount(a.s, aDhan.id);
  const line = await countLineOf(a.s, aCount.id, a.simple.variantId);

  // B's session on A's store path, and A's ids on B's store path
  const viaB: Array<[string, Promise<{ status: number }>]> = [
    ['GET transfer on A path', transferRaw(a.s, t.id, b.s)],
    ['GET transfers on A path', transfersRaw(a.s, '', b.s)],
    ['GET transfer on B path', transferRaw(b.s, t.id)],
    ['send on B path', transferActionRaw(b.s, t.id, 'send')],
    ['cancel on B path', transferActionRaw(b.s, t.id, 'cancel')],
    ['GET count on B path', countRaw(b.s, aCount.id)],
    ['scan on B path', scanRaw(b.s, aCount.id, a.simple.variantId)],
    ['PUT line on B path', setCountedRaw(b.s, aCount.id, line.id, 5)],
    ['finish on B path', countActionRaw(b.s, aCount.id, 'finish', { zero_uncounted: false })],
  ];
  for (const [what, p] of viaB) expect((await p).status, what).toBe(404);

  // B's location in A's transfer / count → 404 or 422, nothing written
  const x = await createTransferRaw(a.s, { from_location_id: aMain.id, to_location_id: bLoc.id, lines: [{ variant_id: a.simple.variantId, quantity: 1 }] });
  expect([404, 422], x.text.slice(0, 200)).toContain(x.status);
  const y = await startCountRaw(a.s, { location_id: bLoc.id });
  expect([404, 422], y.text.slice(0, 200)).toContain(y.status);
  // B's variant in A's transfer → 404/422
  const z = await createTransferRaw(a.s, { from_location_id: aMain.id, to_location_id: aDhan.id, lines: [{ variant_id: b.simple.variantId, quantity: 1 }] });
  expect([404, 422], z.text.slice(0, 200)).toContain(z.status);
  expect((await transfer(a.s, t.id)).status).toBe('draft');
  expect((await countLineOf(a.s, aCount.id, a.simple.variantId)).counted).toBeNull();
});

test('P88C-14: without inventory.adjust a member reads but cannot write; UI read-only', async ({ page, context }) => {
  test.setTimeout(120_000);
  const v = as(viewer);
  const t = await createTransfer(a.s, aMain.id, aDhan.id, [{ variant_id: a.simple.variantId, quantity: 1 }]);
  expect((await transferRaw(a.s, t.id, v)).status).toBe(200);
  expect((await countRaw(a.s, aCount.id, '', v)).status).toBe(200);
  const line = await countLineOf(a.s, aCount.id, a.simple.variantId);
  const denied: Array<[string, Promise<{ status: number; json: Json }>]> = [
    ['create transfer', createTransferRaw(a.s, { from_location_id: aMain.id, to_location_id: aDhan.id, lines: [{ variant_id: a.simple.variantId, quantity: 1 }] }, v)],
    ['send', transferActionRaw(a.s, t.id, 'send', {}, v)],
    ['cancel', transferActionRaw(a.s, t.id, 'cancel', {}, v)],
    ['start count', startCountRaw(a.s, { location_id: aMain.id }, v)],
    ['scan', scanRaw(a.s, aCount.id, 'X', v)],
    ['set line', setCountedRaw(a.s, aCount.id, line.id, 1, v)],
    ['finish', countActionRaw(a.s, aCount.id, 'finish', { zero_uncounted: false }, v)],
  ];
  for (const [what, p] of denied) {
    const r = await p;
    expect([r.status, r.json.error?.code], `viewer ${what}`).toEqual([403, 'forbidden']);
  }

  const c = watchConsole(page);
  await signInDashboard(context, v);
  await openTransfers(page);
  await expect(transferRow(page, t.number)).toBeVisible();
  await expect(newTransferButton(page), 'no "+ New transfer"').toHaveCount(0);
  await openTransfer(page, t.number);
  const p = panel(page);
  await expect(p.getByText(t.number).first()).toBeVisible();
  await expect(p.getByRole('button', { name: /^(Send|Save draft|Receive)/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openCounts(page);
  await expect(startCountButton(page), 'no "Start count"').toHaveCount(0);
  await openCounts(page, `/inventory/counts/${aCount.id}`);
  await expect(page.getByText(aCount.name).first()).toBeVisible();
  await expect(page.getByPlaceholder(SKU_BOX), 'no SKU box').toHaveCount(0);
  await expect(page.getByRole('button', { name: /Finish & adjust stock/ })).toHaveCount(0);
  await expect(transferStockButton(page)).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S191: count values are hidden without costs.view', async ({ page, context }) => {
  test.setTimeout(90_000);
  const k = as(counter);
  const scanned = await scanRaw(a.s, aCount.id, (await countLineOf(a.s, aCount.id, a.simple.variantId)).variant.sku, k);
  expect(scanned.status, scanned.text.slice(0, 200)).toBe(200);
  const mine = (await countRaw(a.s, aCount.id, '', k)).json.data as Json;
  expect(mine.summary, 'summary values null without costs.view').toMatchObject({ short_value_amount: null, extra_value_amount: null, net_value_amount: null });
  expect(mine.net_value_amount).toBeNull();
  const lines = (await countLinesRaw(a.s, aCount.id, '', k)).json.data as Json[];
  for (const l of lines) expect(l.value_amount, 'line value_amount without costs.view').toBeNull();
  const owner = await count(a.s, aCount.id);
  // the count is at Dhanmondi (wrap on hand 0): counted 1 → extra 1 × cost ৳ 200
  expect(owner.summary, 'owner sees values').toMatchObject({ extra_units: 1, extra_value_amount: 20000 });

  const c = watchConsole(page);
  await signInDashboard(context, k);
  await openCounts(page, `/inventory/counts/${aCount.id}`);
  await expect(page.getByPlaceholder(SKU_BOX).or(page.getByRole('textbox', { name: SKU_BOX })).first(), 'counter can count').toBeVisible();
  await expect(page.getByText(/৳/), 'no money without costs.view').toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /^Value$/i })).toHaveCount(0);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
  expect((await countActionRaw(a.s, aCount.id, 'cancel')).status).toBe(200);
});

test('S192: after a downgrade, an in-transit transfer can be received or cancelled; new transfers → 402', async () => {
  const sv = a.simple.variantId;
  const t1 = await createTransfer(a.s, aMain.id, aDhan.id, [{ variant_id: sv, quantity: 1 }]);
  await sendTransfer(a.s, t1.id);
  const t2 = await createTransfer(a.s, aMain.id, aDhan.id, [{ variant_id: sv, quantity: 2 }]);
  await sendTransfer(a.s, t2.id);
  const draft = await createTransfer(a.s, aMain.id, aDhan.id, [{ variant_id: sv, quantity: 1 }]);
  const mainBefore = await stockAt(a.s, sv, aMain.id);
  setPlan(a.s, 'starter');
  try {
    const recv = await transferActionRaw(a.s, t1.id, 'receive', { lines: t1.lines.map((l: Json) => ({ item_id: l.id, received: l.quantity })) });
    expect(recv.status, recv.text.slice(0, 200)).toBe(200);
    const cancel = await transferActionRaw(a.s, t2.id, 'cancel');
    expect(cancel.status, cancel.text.slice(0, 200)).toBe(200);
    expect(await stockAt(a.s, sv, aMain.id)).toMatchObject({ on_hand: mainBefore.on_hand + 2 });

    const create = await createTransferRaw(a.s, { from_location_id: aMain.id, to_location_id: aDhan.id, lines: [{ variant_id: sv, quantity: 1 }] });
    expect([create.status, create.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const send = await transferActionRaw(a.s, draft.id, 'send');
    expect([send.status, send.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    // counts keep working on Starter (P88C-13)
    const cnt = await startCountRaw(a.s, { location_id: aDhan.id });
    expect(cnt.status, cnt.text.slice(0, 200)).toBe(201);
  } finally {
    setPlan(a.s, 'growth');
  }
});
