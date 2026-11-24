import { expect, test, type Page } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { orderIdByNumber, placeOrder, type CommerceShop } from '../support/commerce';
import { watchConsole } from '../support/roles';
import { chooseOption, defaultLocation, movementsWhere, stockAt, stockRow } from '../support/locations';
import { purchasingShop, shipOrder, waitApi } from '../support/purchasing';
import {
  count,
  countLineOf,
  countRaw,
  COUNTS,
  openCounts,
  scanRaw,
  startCount,
  startCountRaw,
  startCountButton,
  typeSku,
} from '../support/transfers';

/**
 * PHASE-8-8C §13 QA part B (count), AC 5, P88C-11, §8, §10.5, S190, S193: **Starter** shop (counts need no plan,
 * P88C-13), one location "Main warehouse", stock 3 per variant (kurta M, kurta L, wrap).
 *  (a) Stock count → "Start count" (Location Main) → count screen; type 3 SKUs (M, L, wrap: each +1, focus kept); click
 *      COUNTED of M and set 2 → expected stored at count time = 3 per line; unknown code → "not found", nothing counted.
 *  (b) Mid-count a storefront order for M (counted line) is placed and shipped → M on hand 2 (sale after counting).
 *  (c) "Finish & adjust stock" (confirm with the summary) → delta = counted − expected per line: M 2 − 3 = −1 → on hand
 *      2 − 1 = **1 = counted minus the order**; L 1, wrap 1; three `count` movements; completed count opens read-only.
 *  (d) Second count with "Set uncounted items to 0": only the wrap typed (+1 → 2 … expected 1, counted 2 → +1) and the
 *      kurtas zeroed (delta −on_hand) → M 0, L 0, wrap 2.
 *  Also: one open count per location → 409 `count_in_progress`; scan `%`/`_` and a 65-char code are not wildcards /
 *  rejected (S193).
 */
test.describe.configure({ mode: 'serial' });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let shop: CommerceShop;
let main: Json;
let countId = '';
const sku: Record<'M' | 'L' | 'W', string> = { M: '', L: '', W: '' };
const vM = () => shop.variable.variants[0].id as string;
const vL = () => shop.variable.variants[1].id as string;
const vW = () => shop.simple.variantId;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('cnt', 'starter', 3);
  main = await defaultLocation(shop.s);
  sku.M = shop.variable.variants[0].sku;
  sku.L = shop.variable.variants[1].sku;
  sku.W = (await stockRow(shop.s, vW()))!.sku;
  expect(sku.W, 'wrap SKU').toBeTruthy();
});
test.afterAll(() => shop?.cleanup());

const countUrl = (id: string) => `${COUNTS}/${id}`;

async function finishInUi(page: Page, zero: boolean): Promise<Json> {
  const box = page.getByRole('switch', { name: 'Set uncounted items to 0' });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked(); // default: uncounted keep their stock (P88C-11)
  if (zero) {
    await box.click();
    await expect(box).toBeChecked();
  }
  await page.getByRole('button', { name: 'Finish & adjust stock' }).click();
  const confirm = page.getByRole('dialog', { name: 'Finish & adjust stock?' }).or(page.getByRole('alertdialog', { name: 'Finish & adjust stock?' })).first();
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('list', { name: 'Finish summary' }).getByText(zero ? /set to 0/ : /keep stock/)).toBeVisible();
  const done = waitApi(page, 'POST', /\/stock-counts\/[0-9A-Za-z]{26}\/finish$/);
  await confirm.getByRole('button', { name: 'Finish & adjust stock' }).click();
  const res = await done;
  expect(res.status(), await res.text()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ zero_uncounted: zero });
  return (await res.json()).data as Json;
}

test('(a) Start a count at Main, type 3 SKUs, click-edit one quantity', async ({ page, context }) => {
  test.setTimeout(150_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openCounts(page);
  await startCountButton(page).click();
  const d = page.getByRole('dialog', { name: 'Start count' });
  await expect(d).toBeVisible();
  await chooseOption(d, page, /^Location/i, 'Main warehouse');
  const started = waitApi(page, 'POST', /\/stock-counts$/);
  await d.getByRole('button', { name: 'Start count' }).click();
  const res = await started;
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()).data as Json;
  countId = created.id;
  expect(created).toMatchObject({ status: 'in_progress' });
  expect(created.location.id).toBe(main.id);
  await expect(page).toHaveURL(new RegExp(`${countUrl(countId)}$`), { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: created.name }).first()).toBeVisible();
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumb.getByRole('link', { name: 'Stock counts' })).toBeVisible();
  await expect(crumb.getByText(/started .* by /)).toBeVisible();

  // one open count per location (P88C-11)
  const dup = await startCountRaw(shop.s, { location_id: main.id });
  expect([dup.status, dup.json.error?.code], dup.text.slice(0, 200)).toEqual([409, 'count_in_progress']);

  // type 3 SKUs (lower-case one: case-insensitive match, §8)
  expect(await typeSku(page, sku.M)).toBe(200);
  expect(await typeSku(page, sku.L.toLowerCase())).toBe(200);
  expect(await typeSku(page, sku.W)).toBe(200);
  // unknown code → 404 `count_line_not_found`, message in the UI, nothing counted
  expect(await typeSku(page, 'NO-SUCH-SKU-QA')).toBe(404);
  await expect(page.getByRole('alert').filter({ hasText: /No product in this count has the SKU or barcode “NO-SUCH-SKU-QA”/ })).toBeVisible();

  for (const v of [vM(), vL(), vW()]) expect(await countLineOf(shop.s, countId, v)).toMatchObject({ counted: 1, expected: 3 });

  // click-edit COUNTED of M → 2
  const edit = page.getByRole('button', { name: 'Edit counted for QA Cotton Kurta M' });
  const row = page.getByRole('row').filter({ has: edit }).or(page.getByRole('listitem').filter({ has: edit })).first();
  await expect(edit).toHaveText('1');
  await edit.click();
  const input = page.getByRole('textbox', { name: 'Counted for QA Cotton Kurta M' });
  await expect(input).toBeFocused();
  const put = waitApi(page, 'PUT', /\/stock-counts\/[0-9A-Za-z]{26}\/lines\/[0-9A-Za-z]{26}$/);
  await input.fill('2');
  await input.press('Enter');
  const pres = await put;
  expect(pres.status(), await pres.text()).toBe(200);
  expect(await countLineOf(shop.s, countId, vM())).toMatchObject({ counted: 2, expected: 3 });
  await expect(page.getByRole('button', { name: 'Edit counted for QA Cotton Kurta M' })).toHaveText('2');
  await expect(row.getByText('−1', { exact: true }), 'difference −1').toBeVisible();

  // chips: Differences · 3 (every counted line differs); Matched · 0
  await page.getByRole('button', { name: /^Differences · 3$/ }).click();
  await expect(page.getByRole('button', { name: /^Edit counted for QA Muslin Wrap$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Matched · 0$/ })).toBeVisible();
  // owner: "If you finish now" shows money (Short = M −1, L −2, wrap −2 at cost)
  const card = page.getByRole('region', { name: 'If you finish now' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/৳/).first(), 'owner sees values (costs.view)').toBeVisible();
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('S193: scan codes are literal (no % / _ wildcards), max 64 chars, only within the count', async () => {
  for (const code of ['%', '_', `${sku.M.slice(0, 4)}%`, 'QA-_-%']) {
    const r = await scanRaw(shop.s, countId, code);
    expect([r.status, r.json.error?.code], `scan ${code}`).toEqual([404, 'count_line_not_found']);
  }
  const long = await scanRaw(shop.s, countId, 'X'.repeat(65));
  expect(long.status, long.text.slice(0, 200)).toBe(422);
  for (const v of [vM(), vL(), vW()]) expect((await countLineOf(shop.s, countId, v)).counted).toBe(v === vM() ? 2 : 1);
});

test('(b) mid-count: a storefront order for M is placed and shipped (sale after counting)', async () => {
  test.setTimeout(120_000);
  const { order } = await placeOrder(shop, vM(), 1);
  await shipOrder(shop.s, await orderIdByNumber(shop.s, order.number));
  expect(await stockAt(shop.s, vM(), main.id)).toEqual({ on_hand: 2, committed: 0, available: 2 });
  // the counted line keeps the expected stored when it was counted
  expect(await countLineOf(shop.s, countId, vM())).toMatchObject({ counted: 2, expected: 3 });
});

test('(c) Finish & adjust stock → stock = counted minus the order; count read-only', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openCounts(page, countUrl(countId));
  await expect(page.getByText(/If you finish now/).first()).toBeVisible();
  const done = await finishInUi(page, false);
  expect(done.status).toBe('completed');

  expect(await stockAt(shop.s, vM(), main.id), 'M: on hand 2 + (2 − 3) = 1 = counted 2 − order 1').toEqual({ on_hand: 1, committed: 0, available: 1 });
  expect(await stockAt(shop.s, vL(), main.id)).toMatchObject({ on_hand: 1 });
  expect(await stockAt(shop.s, vW(), main.id)).toMatchObject({ on_hand: 1 });
  const mv = (await movementsWhere(shop.s, { reason: 'count' })).filter((m) => m.reference?.id === countId);
  const key = (m: Json) => [m.variant_id, m.delta];
  expect(mv.map(key).sort()).toEqual([[vM(), -1], [vL(), -2], [vW(), -2]].sort());
  for (const m of mv) expect(m).toMatchObject({ reference: expect.objectContaining({ type: 'stock_count' }) });

  // completed → read-only: no SKU box, no finish, no editable cells
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).getByText('Completed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Edit counted for/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Result' })).toBeVisible();
  await expect(page.getByPlaceholder(/Type or scan a SKU/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Finish & adjust stock/ })).toHaveCount(0);
  const fin = await countRaw(shop.s, countId);
  expect(fin.json.data.status).toBe('completed');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('(d) "Set uncounted items to 0": uncounted lines go to 0, the counted one gets its delta', async ({ page, context }) => {
  test.setTimeout(120_000);
  const second = await startCount(shop.s, main.id, { name: 'QA zero count' });
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await openCounts(page, countUrl(second.id));
  expect(await typeSku(page, sku.W)).toBe(200);
  expect(await typeSku(page, sku.W)).toBe(200);
  expect(await countLineOf(shop.s, second.id, vW())).toMatchObject({ counted: 2, expected: 1 });
  await page.getByRole('button', { name: /^Not counted · 2$/ }).click();
  await expect(page.getByRole('button', { name: 'Edit counted for QA Cotton Kurta L' })).toBeVisible();
  await finishInUi(page, true);

  expect(await stockAt(shop.s, vM(), main.id)).toMatchObject({ on_hand: 0 });
  expect(await stockAt(shop.s, vL(), main.id)).toMatchObject({ on_hand: 0 });
  expect(await stockAt(shop.s, vW(), main.id)).toMatchObject({ on_hand: 2 });
  const d = await count(shop.s, second.id);
  expect(d.status).toBe('completed');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
