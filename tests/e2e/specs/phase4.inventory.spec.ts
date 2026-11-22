import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, urls, type Session } from '../support/api';
import { Tracker, movementCount, purgeRun, simpleProduct, variableProduct } from '../support/catalog';

/**
 * Phase 4 §3.3 / §15.3: inventory adjustments and the ledger on the demo store.
 *  - API: delta and set; insufficient stock → 422 with nothing written (all-or-nothing); expected_on_hand
 *    mismatch → 409; one ledger row per change with actor and on_hand_after; zero delta → no row;
 *    status thresholds incl. untracked; parallel −1s never go negative.
 *  - UI: Adjust dialog (reason, + / − / set, note) → the Stock movements tab shows the row; low-stock badge.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const I = () => `/stores/${s.storeId}/inventory`;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  expect(problems, 'cleanup').toEqual([]);
});

test('API: delta, set, expected_on_hand, all-or-nothing, ledger rows', async () => {
  const p = await t.createProduct(variableProduct('Ledger', ['S', 'M'], ['Red'], 10000));
  const [a, b] = p.variants as Array<{ id: string }>;
  const before = await movementCount(s, p.id); // 2 × initial (3 each)
  expect(before).toBe(2);

  const recv = await api(s, 'POST', `${I()}/adjustments`, { reason: 'received', items: [{ variant_id: a!.id, mode: 'delta', quantity: 10 }] });
  expect(recv.status, JSON.stringify(recv.json)).toBe(200);
  expect(recv.json.data.items[0]).toMatchObject({ variant_id: a!.id, on_hand: 13, available: 13, committed: 0 });
  expect(recv.json.data.movements[0]).toMatchObject({ delta: 10, on_hand_after: 13, reason: 'received' });
  expect(recv.json.data.movements[0].actor).toBeTruthy();

  // Set with the right expected value.
  const set = await api(s, 'POST', `${I()}/adjustments`, { reason: 'correction', items: [{ variant_id: a!.id, mode: 'set', quantity: 8, expected_on_hand: 13 }] });
  expect(set.status, JSON.stringify(set.json)).toBe(200);
  expect(set.json.data.movements[0]).toMatchObject({ delta: -5, on_hand_after: 8 });

  // Stale expected value → 409 stock_changed, nothing written.
  const stale = await api(s, 'POST', `${I()}/adjustments`, { reason: 'correction', items: [{ variant_id: a!.id, mode: 'set', quantity: 1, expected_on_hand: 13 }] });
  expect(stale.status).toBe(409);
  expect(stale.json.error.code).toBe('stock_changed');
  expect(Object.keys(stale.json.error.details)).toContain('items.0.expected_on_hand');

  // One good line + one that would go negative → 422 insufficient_stock, and the good line is NOT applied.
  const mixed = await api(s, 'POST', `${I()}/adjustments`, {
    reason: 'damaged',
    items: [
      { variant_id: a!.id, mode: 'delta', quantity: -1 },
      { variant_id: b!.id, mode: 'delta', quantity: -4 },
    ],
  });
  expect(mixed.status).toBe(422);
  expect(mixed.json.error.code).toBe('insufficient_stock');
  expect(mixed.json.error.details['items.1.quantity']).toEqual(['Only 3 in stock.']);
  const level = await api(s, 'GET', `${I()}?filter[product_id]=${p.id}`);
  expect(level.json.data.find((i: { variant_id: string }) => i.variant_id === a!.id).on_hand).toBe(8);

  // Zero delta (set to the same value) writes no row.
  const zero = await api(s, 'POST', `${I()}/adjustments`, { reason: 'correction', items: [{ variant_id: b!.id, mode: 'set', quantity: 3 }] });
  expect(zero.status).toBe(200);
  expect(zero.json.data.movements).toEqual([]);

  // Validation: reason other needs a note; delta 0 → 422; duplicate variant ids → 422; unknown variant → 422.
  for (const body of [
    { reason: 'other', items: [{ variant_id: a!.id, mode: 'delta', quantity: 1 }] },
    { reason: 'received', items: [{ variant_id: a!.id, mode: 'delta', quantity: 0 }] },
    { reason: 'received', items: [{ variant_id: a!.id, mode: 'delta', quantity: 1 }, { variant_id: a!.id, mode: 'delta', quantity: 1 }] },
    { reason: 'received', items: [{ variant_id: '01J00000000000000000000000', mode: 'delta', quantity: 1 }] },
    { reason: 'initial', items: [{ variant_id: a!.id, mode: 'delta', quantity: 1 }] },
    { reason: 'received', items: [{ variant_id: a!.id, mode: 'set', quantity: -1 }] },
    { reason: 'received', items: [{ variant_id: a!.id, mode: 'delta', quantity: 1.5 }] },
  ]) {
    expect((await api(s, 'POST', `${I()}/adjustments`, body)).status, JSON.stringify(body)).toBe(422);
  }

  expect(await movementCount(s, p.id)).toBe(before + 2); // received + correction only
  const ledger = await api(s, 'GET', `${I()}/movements?filter[variant_id]=${a!.id}`);
  expect(ledger.json.data.map((m: { reason: string }) => m.reason)).toEqual(['correction', 'received', 'initial']); // newest first
});

test('API: status thresholds and untracked; summary counts', async () => {
  const p = await t.createProduct(simpleProduct('Threshold', 10000, { initial_on_hand: 5 }));
  const v = p.variants[0].id as string;
  const get = async () => (await api(s, 'GET', `${I()}?filter[product_id]=${p.id}`)).json.data[0];
  expect((await get()).status).toBe('low_stock'); // 5 ≤ default 5
  expect((await api(s, 'PATCH', `${I()}/${v}`, { low_stock_threshold: 2 })).status).toBe(200);
  expect((await get())).toMatchObject({ status: 'in_stock', effective_threshold: 2 });
  await api(s, 'POST', `${I()}/adjustments`, { reason: 'lost', items: [{ variant_id: v, mode: 'set', quantity: 0 }] });
  expect((await get()).status).toBe('out_of_stock');
  expect((await api(s, 'PATCH', `${I()}/${v}`, { low_stock_threshold: 100_001 })).status).toBe(422);

  const list = await api(s, 'GET', `${I()}?filter[stock]=out`);
  expect(list.json.data.some((i: { variant_id: string }) => i.variant_id === v)).toBe(true);
  const sum = list.json.meta.summary;
  for (const k of ['stock_value_cost_amount', 'stock_value_price_amount', 'units_on_hand', 'committed_units', 'low_stock_variants', 'out_of_stock_variants', 'variants_count', 'products_count']) {
    expect(sum, k).toHaveProperty(k);
  }
  expect(sum.committed_units).toBe(0);
});

test('API: 20 parallel −1 adjustments on stock 10 → exactly 0, never negative', async () => {
  const p = await t.createProduct(simpleProduct('Race', 10000, { initial_on_hand: 10 }));
  const v = p.variants[0].id as string;
  const results = await Promise.all(
    Array.from({ length: 20 }, () => api(s, 'POST', `${I()}/adjustments`, { reason: 'damaged', items: [{ variant_id: v, mode: 'delta', quantity: -1 }] })),
  );
  const codes = results.map((r) => r.status);
  expect(codes.filter((c) => c === 200)).toHaveLength(10);
  expect(codes.filter((c) => c !== 200).every((c) => c === 422 || c === 429)).toBe(true);
  const level = (await api(s, 'GET', `${I()}?filter[product_id]=${p.id}`)).json.data[0];
  expect(level.on_hand).toBe(0);
  expect(await movementCount(s, p.id)).toBe(11); // initial + 10 damaged
});

test('UI: Adjust → Stock movements shows the row; low-stock badge follows the threshold', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const p = await t.createProduct(simpleProduct('Adjust UI', 10000, { initial_on_hand: 9 }));
  await page.goto(`${urls.merchant}/inventory?q=${encodeURIComponent(p.name)}`);
  const row = page.getByRole('row').filter({ hasText: p.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/In stock/i);

  await row.getByRole('button', { name: new RegExp(`^Adjust ${p.name}`) }).click();
  const dialog = page.getByRole('dialog', { name: 'Adjust stock' });
  await dialog.getByLabel('Reason').selectOption({ label: 'Damaged' });
  await dialog.getByRole('tab', { name: '− Remove' }).click();
  await dialog.getByLabel('Quantity').fill('5');
  await expect(dialog.getByText('On hand after: 4')).toBeVisible();
  await dialog.getByLabel(/^Note/).fill(`e2e ${p.name}`);
  const sent = page.waitForRequest((r) => r.url().endsWith('/inventory/adjustments') && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.items[0]).toHaveProperty('expected_on_hand', 9); // §12 dashboard: dialog sends expected_on_hand
  await expect.poll(async () => (await api(s, 'GET', `${I()}?filter[product_id]=${p.id}`)).json.data[0].on_hand).toBe(4);
  await expect(row).toContainText(/Low/i); // 4 ≤ 5

  await page.getByRole('tab', { name: /Stock movements/ }).click();
  const mv = page.getByRole('row').filter({ hasText: p.name }).filter({ hasText: /Damaged/i });
  await expect(mv.first()).toBeVisible();
  await expect(mv.first()).toContainText(/−5|-5/);
});
