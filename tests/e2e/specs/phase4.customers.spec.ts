import { expect, test } from '@playwright/test';
import { api, demoSession, signInDashboard, urls, type Session } from '../support/api';
import { RUN, Tracker, purgeRun, tagged } from '../support/catalog';

/**
 * Phase 4 §3.5 / §15.5: customers on the demo store.
 *  - API: phone normalisation (01556-120987 / +880… / 880… → 8801556120987), foreign number → 422,
 *    duplicate phone/email → 422, search by 0155 / 8801556 / email part / name, revision lock, notes,
 *    never-writable fields ignored.
 *  - UI: add a customer from the dialog, search by phone, open the detail, add a note.
 */
test.describe.configure({ mode: 'serial' });

let s: Session;
let t: Tracker;
const CU = () => `/stores/${s.storeId}/customers`;
// Random BD numbers per run so reruns never collide with leftovers: 01 3-9 + 8 digits.
const phone = () => `01${3 + Math.floor(Math.random() * 7)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const msisdn = (local: string) => `88${local.replace(/\D/g, '')}`;

test.beforeAll(async () => {
  s = await demoSession();
  t = new Tracker(s);
});

test.afterAll(async () => {
  const problems = await t.cleanup();
  purgeRun(s.storeId);
  expect(problems, 'cleanup').toEqual([]);
});

test('API: phone normalisation, duplicates, never-writable fields', async () => {
  const local = phone();
  const dashed = `${local.slice(0, 5)}-${local.slice(5)}`;
  const c = await t.createCustomer({ name: tagged('Farhana Rahman'), phone: dashed, district: 'Narayanganj', channel: 'instagram', tags: ['Repeat Buyer'], orders_count: 9, total_spent_amount: 999, source: 'storefront', revision: 50 });
  expect(c).toMatchObject({ phone: msisdn(local), email: null, orders_count: 0, total_spent_amount: 0, source: 'manual', revision: 1, currency: 'BDT', notes: [], tags: ['repeat buyer'] });

  for (const variant of [`+88${local}`, `88${local}`, local]) {
    const dup = await api(s, 'POST', CU(), { name: tagged('Dup'), phone: variant });
    expect(dup.status, variant).toBe(422);
    expect(dup.json.error.details.phone).toEqual(['A customer with this phone already exists.']);
  }
  const foreign = await api(s, 'POST', CU(), { name: tagged('Foreign'), phone: '+14155550100' });
  expect(foreign.status).toBe(422);
  expect(foreign.json.error.details.phone).toEqual(['Enter a Bangladeshi mobile number (01XXXXXXXXX).']);
  expect((await api(s, 'POST', CU(), { name: tagged('Nothing') })).status).toBe(422); // phone or email

  const email = `e2e-${RUN}@Example.COM`;
  const e = await t.createCustomer({ name: tagged('Email only'), email });
  expect(e.email).toBe(email.toLowerCase());
  expect((await api(s, 'POST', CU(), { name: tagged('Dup mail'), email: email.toUpperCase() })).status).toBe(422);

  // PATCH: revision required + conflict; never-writable fields ignored.
  const p1 = await api(s, 'PATCH', `${CU()}/${c.id}`, { revision: 1, area: 'Fatullah', orders_count: 5, last_order_at: '2026-01-01T00:00:00Z' });
  expect(p1.status, JSON.stringify(p1.json)).toBe(200);
  expect(p1.json.data).toMatchObject({ area: 'Fatullah', orders_count: 0, last_order_at: null, revision: 2 });
  const p2 = await api(s, 'PATCH', `${CU()}/${c.id}`, { revision: 1, area: 'X' });
  expect(p2.status).toBe(409);
  expect(p2.json.error.code).toBe('revision_conflict');
});

test('API: search by phone prefix, 8801 prefix, email part and name', async () => {
  const local = phone();
  const c = await t.createCustomer({ name: tagged('Searchable Sumaiya'), phone: local, email: `sumaiya-${RUN}@e2e.example` });
  const found = async (q: string) => ((await api(s, 'GET', `${CU()}?q=${encodeURIComponent(q)}&per_page=100`)).json.data as Array<{ id: string }>).some((x) => x.id === c.id);
  expect(await found(local.slice(0, 7)), '01… prefix').toBe(true);
  expect(await found(`88${local.slice(0, 7)}`), '8801… prefix').toBe(true);
  expect(await found(local.slice(-6)), 'contains digits').toBe(true);
  expect(await found(`sumaiya-${RUN}@`), 'email part').toBe(true);
  expect(await found(`${RUN} Searchable`), 'name').toBe(true);
  expect(await found('zz-no-such-name-zz'), 'no match').toBe(false);
  expect((await api(s, 'GET', `${CU()}?q=${'x'.repeat(101)}`)).status).toBe(422);
});

test('API: notes — add, list newest first, delete own', async () => {
  const c = await t.createCustomer({ name: tagged('Noted'), phone: phone() });
  const n1 = await api(s, 'POST', `${CU()}/${c.id}/notes`, { body: 'Prefers COD, call after 6pm' });
  expect(n1.status).toBe(201);
  expect(n1.json.data).toMatchObject({ body: 'Prefers COD, call after 6pm', can_delete: true });
  await api(s, 'POST', `${CU()}/${c.id}/notes`, { body: 'Second note' });
  expect((await api(s, 'POST', `${CU()}/${c.id}/notes`, { body: 'x'.repeat(1001) })).status).toBe(422);
  const d = await api(s, 'GET', `${CU()}/${c.id}`);
  expect(d.json.data.notes.map((n: { body: string }) => n.body)).toEqual(['Second note', 'Prefers COD, call after 6pm']);
  expect((await api(s, 'DELETE', `${CU()}/${c.id}/notes/${n1.json.data.id}`)).status).toBe(204);
  // A note id under another customer → 404 (scopeBindings).
  const other = await t.createCustomer({ name: tagged('Other'), phone: phone() });
  const n2 = d.json.data.notes[0].id;
  expect((await api(s, 'DELETE', `${CU()}/${other.id}/notes/${n2}`)).status).toBe(404);
});

test('UI: add a customer, search by phone, open the detail and add a note', async ({ page, context }) => {
  test.setTimeout(90_000);
  await signInDashboard(context, s);
  const local = phone();
  const name = tagged('Rumana Akter');
  await page.goto(`${urls.merchant}/customers`);
  await page.getByRole('button', { name: /Add customer/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add customer' });
  await dialog.getByLabel(/^Name/i).fill(name);
  await dialog.getByLabel(/^Phone/i).fill(local);
  await dialog.getByLabel(/^District/i).fill('Dhaka');
  const created = page.waitForResponse((r) => r.url().endsWith(CU()) && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Add customer' }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const c = (await res.json()).data;
  t.customers.add(c.id);

  // Saving opens the new customer's page; go back to the list and find them by phone.
  await page.waitForURL(new RegExp(`/customers/${c.id}$`));
  await page.goto(`${urls.merchant}/customers`);
  await page.getByPlaceholder('Name, phone or email').fill(local.slice(0, 8));
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  // Phone shown formatted (+880 1XXX-XXXXXX).
  await expect(row).toContainText(`+880 ${local.slice(1, 5)}-${local.slice(5)}`);
  await row.getByRole('link', { name }).first().click();
  await page.waitForURL(new RegExp(`/customers/${c.id}$`));

  const wa = page.getByRole('link', { name: /WhatsApp/ }).first();
  await expect(wa).toHaveAttribute('href', `https://wa.me/${msisdn(local)}`);
  await expect(wa).toHaveAttribute('rel', /noopener/);
  await page.getByLabel('Add a note').fill('Asked for size chart');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Asked for size chart')).toBeVisible();
  // Deferred Figma bits are not rendered (§9.1, Q23).
  await expect(page.getByText(/Delivery record across Storeplix/i)).toHaveCount(0);
});
