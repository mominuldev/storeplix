import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, urls, type Session } from '../support/api';
import { RUN, Tracker, purgeRun, simpleProduct, tagged } from '../support/catalog';

/**
 * Phase 4 §3.1 / §15.1: categories on the demo store.
 *  - API: a 3-level tree, a 4th level refused, moving under its own descendant refused, delete with
 *    children → 409, delete leaf detaches products, reorder (full list; stale list → 422), slug rules.
 *  - UI: /products/categories lists the tree ("/slug · N sub-categories", "In menu"/"Hidden") and the side
 *    panel creates a sub-category.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const C = () => `/stores/${s.storeId}/categories`;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId, [...t.products]);
  expect(problems, 'cleanup').toEqual([]);
});

test('API: 3-level tree; depth 4, self-nesting and deleting a parent are refused', async () => {
  const l1 = await t.createCategory({ name: tagged('Women') });
  const l2 = await t.createCategory({ name: tagged('Sarees'), parent_id: l1.id });
  const l3 = await t.createCategory({ name: tagged('Jamdani'), parent_id: l2.id, is_visible: false });
  expect([l1.depth, l2.depth, l3.depth]).toEqual([1, 2, 3]);
  expect(l1.url_path).toBe(`/c/${l1.slug}`);
  expect(l1.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

  const l4 = await api(s, 'POST', C(), { name: tagged('Too deep'), parent_id: l3.id });
  expect(l4.status).toBe(422);
  expect(l4.json.error.details.parent_id).toEqual(['Categories can only be three levels deep.']);

  const self = await api(s, 'PATCH', `${C()}/${l1.id}`, { parent_id: l3.id });
  expect(self.status).toBe(422);
  expect(self.json.error.details.parent_id).toBeTruthy();

  // Moving a 2-level subtree under another depth-2 node would make depth 4.
  const other = await t.createCategory({ name: tagged('Men') });
  const other2 = await t.createCategory({ name: tagged('Panjabi'), parent_id: other.id });
  const tooDeepMove = await api(s, 'PATCH', `${C()}/${l2.id}`, { parent_id: other2.id });
  expect(tooDeepMove.status).toBe(422);

  const slugTaken = await api(s, 'POST', C(), { name: tagged('Clash'), slug: l1.slug });
  expect(slugTaken.status).toBe(422);
  expect(slugTaken.json.error.details.slug).toEqual(['This link is already used by another category.']);
  for (const bad of ['Upper', 'a--b', '-a', 'a_b']) {
    expect((await api(s, 'POST', C(), { name: tagged('Bad slug'), slug: bad })).status, bad).toBe(422);
  }

  const del = await api(s, 'DELETE', `${C()}/${l2.id}`);
  expect(del.status).toBe(409);
  expect(del.json.error.code).toBe('category_has_children');

  // List: flat, depth-first; children counts.
  const list = await api(s, 'GET', `${C()}?q=${encodeURIComponent(RUN)}`);
  expect(list.status).toBe(200);
  const ours = (list.json.data as Array<{ id: string; children_count: number }>).filter((c) => [l1.id, l2.id, l3.id].includes(c.id));
  expect(ours.map((c) => c.id)).toEqual([l1.id, l2.id, l3.id]);
  expect(ours[0]!.children_count).toBe(1);
  expect(list.json.meta.limit).toBe(500);
});

test('API: deleting a leaf detaches its products; reorder needs the full, current list', async () => {
  const parent = await t.createCategory({ name: tagged('Home') });
  const leaf = await t.createCategory({ name: tagged('Mugs'), parent_id: parent.id });
  const p = await t.createProduct(simpleProduct('Mug', 50000, { category_ids: [leaf.id] }));
  expect(p.categories.map((c: { id: string }) => c.id)).toEqual([leaf.id]);

  const all = await api(s, 'GET', C());
  const items = (all.json.data as Array<{ id: string; parent_id: string | null }>).map(({ id, parent_id }) => ({ id, parent_id }));
  // Stale list (one missing) → 422.
  const stale = await api(s, 'PUT', `${C()}/order`, { items: items.slice(1) });
  expect(stale.status).toBe(422);
  expect(stale.json.error.details.items).toEqual(['The list is out of date. Reload and try again.']);
  // Cycle → 422.
  const cyc = items.map((i) => (i.id === parent.id ? { ...i, parent_id: leaf.id } : i));
  expect((await api(s, 'PUT', `${C()}/order`, { items: cyc })).status).toBe(422);
  // Same list, leaf moved to the top level → 200 and depth recomputed.
  const moved = items.map((i) => (i.id === leaf.id ? { ...i, parent_id: null } : i));
  const ok = await api(s, 'PUT', `${C()}/order`, { items: moved });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  expect(ok.json.data.find((c: { id: string }) => c.id === leaf.id).depth).toBe(1);
  // Put it back.
  expect((await api(s, 'PUT', `${C()}/order`, { items })).status).toBe(200);

  const del = await api(s, 'DELETE', `${C()}/${leaf.id}`);
  expect(del.status).toBe(204);
  t.categories = t.categories.filter((id) => id !== leaf.id);
  const after = await api(s, 'GET', `/stores/${s.storeId}/products/${p.id}`);
  expect(after.json.data.categories).toEqual([]);
});

test('UI: categories page shows the tree and the side panel creates a sub-category', async ({ page, context }) => {
  await signInDashboard(context, s);
  const top = await t.createCategory({ name: tagged('Kids') });
  await page.goto(`${urls.merchant}/products/categories`);
  const row = page.getByText(top.name, { exact: true }).first();
  await expect(row).toBeVisible();
  await expect(page.getByText(`/${top.slug}`).first()).toBeVisible();
  await expect(page.getByText('In menu').first()).toBeVisible();
  // Collections are deferred (§9.1).
  await expect(page.getByRole('tab', { name: /^Collections/ })).toHaveCount(0);

  await page.getByRole('button', { name: /^(\+ )?New category/ }).first().click();
  const panel = page.getByRole('region', { name: 'New category' }).or(page.getByRole('dialog', { name: 'New category' })).first();
  const childName = tagged('Toys');
  await panel.getByLabel('Category name').fill(childName);
  await panel.getByLabel('Parent category').selectOption({ label: top.name });
  const created = page.waitForResponse((r) => r.url().endsWith(`/stores/${s.storeId}/categories`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: /^(Save|Create|Add)/ }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const child = (await res.json()).data;
  t.categories.push(child.id);
  expect(child).toMatchObject({ parent_id: top.id, depth: 2 });
  await expect(page.getByText(/1 sub-categor/).first()).toBeVisible();
});
