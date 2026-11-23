import { expect, test, type Page } from '@playwright/test';
import { acceptInvitation, api, deleteE2eUser, mailMark, signInDashboard, unique, urls, type Session } from '../support/api';
import {
  LABEL,
  getRole,
  listRoles,
  myMembership,
  navLabels,
  noAccess,
  roleByName,
  shopOn,
  sidebar,
  staffRow,
  staffUrl,
  systemRole,
  watchApiErrors,
  watchConsole,
  type PermissionKey,
  type Shop,
} from '../support/roles';

/**
 * PHASE-8-3 §10 QA `phase8-3.roles` (AC 3, 5; S97): a Growth owner creates "Order staff" (orders.view, orders.process,
 * shipments.manage) in the role editor, invites a member with it through the invite modal, and the member sees Orders /
 * Shipments but no Customers / Reports / Staff, no product cost; forbidden deep links show the no-access state and the
 * API answers 403. The owner then adds `customers.view` in the editor: the member's next navigation (window focus →
 * /auth/me refetch, P83-6) shows Customers without signing out. Finally the owner moves the member to Staff with the row
 * menu "Change role" and back again.
 */
test.describe.configure({ mode: 'serial' });

const ORDER_STAFF: PermissionKey[] = ['orders.view', 'orders.process', 'shipments.manage'];

let shop: Shop;
let roleName: string;
let roleId: string;
let memberEmail: string;
let member: Session;

const sid = () => shop.s.storeId;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  shop = await shopOn('growth', 'roles');
  roleName = `Order staff ${unique('').slice(-4)}`;
});

test.afterAll(async () => {
  if (memberEmail) deleteE2eUser(memberEmail);
  shop?.cleanup();
});

test('owner creates a custom role in the role editor (prerequisites auto-tick)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl());
  await expect(page.getByRole('heading', { name: /^Staff$/, level: 1 })).toBeVisible();
  // Three system roles on a fresh shop, in order.
  const card = page.getByLabel('Roles', { exact: true });
  await expect(card.getByRole('link', { name: /role$/ })).toHaveText([/Owner/, /Manager/, /Staff/]);

  await card.getByRole('button', { name: '+ Custom role' }).click();
  await expect(page).toHaveURL(/\/staff\/roles\/new$/);
  await page.getByLabel('Role name').fill(roleName);
  await page.getByLabel('Description').fill('Confirms orders and books couriers');
  // P83-11: ticking "Confirm & cancel orders" ticks its prerequisite "View & create orders".
  await page.getByRole('switch', { name: LABEL['orders.process'] }).click();
  await expect(page.getByRole('switch', { name: LABEL['orders.view'] })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('switch', { name: LABEL['shipments.manage'] }).click();
  // billing.manage is never grantable.
  await expect(page.getByRole('switch', { name: LABEL['billing.manage'] })).toBeDisabled();

  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/roles') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Create role$/ }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  roleId = ((await res.json()) as { data: { id: string } }).data.id;
  await expect(page).toHaveURL(new RegExp(`/staff/roles/${roleId}$`));

  const role = await getRole(shop.s, roleId);
  expect(role).toMatchObject({ name: roleName, key: null, is_system: false, permissions: ORDER_STAFF, revision: 1, members_count: 0 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('owner invites a member with the custom role through the invite modal', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl());
  await page.getByRole('button', { name: '+ Invite staff' }).click();
  const modal = page.getByRole('dialog', { name: /Invite staff member/ });
  await expect(modal).toBeVisible();
  // §7.4: Manager, Staff, then custom roles; the owner can assign every one; no warehouse / per-person permissions.
  await expect(modal.getByRole('radio')).toHaveCount(3);
  await expect(modal.getByRole('radio', { name: /Manager/ })).toBeEnabled();
  await expect(modal.getByRole('radio', { name: /^Staff/ })).toBeChecked();
  await expect(modal.getByText(/Warehouse access|Permissions for this person/)).toHaveCount(0);

  memberEmail = `${unique('r83-os-')}@e2e.storeplix.test`;
  await modal.getByLabel('Full name').fill('Order Staffer');
  await modal.getByLabel('Email').fill(memberEmail);
  await modal.getByRole('radio', { name: new RegExp(roleName) }).check();
  const mark = mailMark();
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/staff/invitations') && r.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Send invite' }).click();
  const res = await sent;
  expect(res.status(), await res.text()).toBe(201);
  expect(((await res.json()) as { data: { role: string; role_id: string; role_name: string } }).data).toMatchObject({ role: 'custom', role_id: roleId, role_name: roleName });
  await expect(modal).toBeHidden();
  await expect(page.getByRole('row').filter({ hasText: memberEmail })).toContainText(roleName);

  member = await acceptInvitation(shop.s, memberEmail, mark, 'Order Staffer');
  const m = await myMembership(member);
  expect(m).toMatchObject({ role: 'custom', role_id: roleId, role_name: roleName });
  expect(m.permissions).toEqual(ORDER_STAFF);
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: the member gets exactly the role (403 forbidden outside it, cost null)', async () => {
  const ok: Array<[string, string]> = [
    ['GET', `/stores/${sid()}/orders`],
    ['GET', `/stores/${sid()}/shipments`],
    ['GET', `/stores/${sid()}/products`], // base
    ['GET', `/stores/${sid()}/inventory`], // base
  ];
  for (const [m, p] of ok) expect((await api(member, m, p)).status, `${m} ${p}`).toBe(200);
  const denied: Array<[string, string, unknown?]> = [
    ['GET', `/stores/${sid()}/customers`],
    ['GET', `/stores/${sid()}/reports/sales`],
    ['GET', '/staff'],
    ['GET', '/roles'],
    ['GET', '/audit-logs'],
    ['GET', '/subscription'],
    ['PATCH', `/stores/${sid()}/settings`, { name: 'x' }],
    ['POST', `/stores/${sid()}/products`, { name: 'x', variants: [{ sku: 'X', price_amount: 1 }] }],
  ];
  for (const [m, p, b] of denied) {
    const r = await api(member, m, p, b);
    expect([r.status, r.json.error?.code], `${m} ${p}`).toEqual([403, 'forbidden']);
  }
  const products = await api(member, 'GET', `/stores/${sid()}/products`);
  for (const p of products.json.data as Array<{ cost_amount: unknown }>) expect(p.cost_amount).toBeNull();
  const inv = await api(member, 'GET', `/stores/${sid()}/inventory`);
  expect(inv.json.meta.summary.stock_value_cost_amount).toBeNull();
});

async function expectMemberNav(page: Page, visible: string[], hidden: string[]) {
  const labels = await navLabels(page);
  for (const v of visible) expect(labels, `nav shows ${v}: ${labels.join(', ')}`).toContain(v);
  for (const h of hidden) expect(labels, `nav hides ${h}: ${labels.join(', ')}`).not.toContain(h);
}

test('UI: the member sees only the permitted nav; forbidden deep links show no-access', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  const apiErrors = watchApiErrors(page);
  await signInDashboard(context, member);
  await page.goto(`${urls.merchant}/orders`);
  await expect(page.getByRole('heading', { name: /^Orders$/, level: 1 })).toBeVisible();
  await expectMemberNav(page, ['Orders', 'All orders', 'Shipments', 'Products', 'Inventory'], ['Customers', 'Reports', 'Staff', 'Import']);

  // Product editor: no cost field (costs.view missing).
  await page.goto(`${urls.merchant}/products/new`);
  await expect(page.getByLabel(/^Product name/i)).toBeVisible();
  await expect(page.getByLabel(/^Cost/i)).toHaveCount(0);

  for (const path of ['/customers', '/reports/sales', '/reports/profit']) {
    await page.goto(`${urls.merchant}${path}`);
    await expect(noAccess(page), path).toBeVisible();
  }
  await page.goto(staffUrl());
  await expect(page.getByText('You can’t manage staff')).toBeVisible();
  await page.goto(staffUrl(`/roles/${roleId}`));
  await expect(page.getByText('You can’t manage staff')).toBeVisible();

  expect(c.errors, c.errors.join('\n')).toEqual([]);
  // The SPA itself must not call endpoints the member can't use.
  const forbidden = apiErrors.filter((e) => e.endsWith('→ 403'));
  test.info().annotations.push({ type: 'api-403', description: forbidden.join('; ') || 'none' });
  expect(forbidden, forbidden.join('\n')).toEqual([]);
});

test('owner adds customers.view in the editor → the member’s next navigation shows Customers (no sign-out)', async ({ browser }) => {
  test.setTimeout(120_000);
  // Member keeps a tab open.
  const memberCtx = await browser.newContext();
  const mp = await memberCtx.newPage();
  const ownerCtx = await browser.newContext();
  const op = await ownerCtx.newPage();
  try {
    await signInDashboard(memberCtx, member);
    await mp.goto(`${urls.merchant}/orders`);
    await expect(sidebar(mp).getByRole('link', { name: /^All orders$/ })).toBeVisible();
    await expect(sidebar(mp).getByRole('link', { name: /^Customers$/ })).toHaveCount(0);

    await signInDashboard(ownerCtx, shop.s);
    await op.goto(staffUrl(`/roles/${roleId}`));
    await expect(op.getByRole('heading', { name: roleName, level: 1 })).toBeVisible();
    await op.getByRole('switch', { name: LABEL['customers.view'] }).click();
    const saved = op.waitForResponse((r) => r.url().endsWith(`/api/v1/roles/${roleId}`) && r.request().method() === 'PATCH');
    await op.getByRole('button', { name: /^Save (role|changes)$/ }).first().click();
    expect((await saved).status()).toBe(200);
    expect((await getRole(shop.s, roleId)).permissions).toEqual(['orders.view', 'orders.process', 'shipments.manage', 'customers.view']);

    // S97: next request, no cache flush.
    expect((await api(member, 'GET', `/stores/${sid()}/customers`)).status).toBe(200);
    // P83-6: the SPA refetches /auth/me when the tab regains focus (TanStack's focusManager listens to
    // `visibilitychange`, which is what switching back to the tab fires); the nav updates in place.
    const me = mp.waitForResponse((r) => r.url().endsWith('/api/v1/auth/me') && r.status() === 200);
    await mp.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await me;
    await expect(sidebar(mp).getByRole('link', { name: /^Customers$/ })).toBeVisible({ timeout: 15_000 });
    await sidebar(mp).getByRole('link', { name: /^Customers$/ }).click();
    await expect(mp.getByRole('heading', { name: /^Customers$/, level: 1 })).toBeVisible();
    await expect(noAccess(mp)).toHaveCount(0);
    // Still no export (data.export not granted).
    await expect(mp.getByRole('button', { name: /^Export/ }).or(mp.getByRole('link', { name: /^Export/ }))).toHaveCount(0);
  } finally {
    await memberCtx.close();
    await ownerCtx.close();
  }
});

test('owner changes the member’s role with the row menu (Staff), then back to the custom role', async ({ page, context }) => {
  test.setTimeout(120_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl());
  const row = page.getByRole('row').filter({ hasText: memberEmail });
  await expect(row).toContainText(roleName);

  const pick = async (name: RegExp) => {
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Change role' }).click();
    const d = page.getByRole('dialog', { name: /role$/ });
    await expect(d).toBeVisible();
    await expect(d.getByRole('radio', { name: /Owner/ })).toHaveCount(0); // owner never assignable
    await d.getByRole('radio', { name }).check();
    const patched = page.waitForResponse((r) => /\/api\/v1\/staff\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH');
    await d.getByRole('button', { name: 'Save role' }).click();
    expect((await patched).status()).toBe(200);
    await expect(d).toBeHidden();
  };

  await pick(/^Staff/);
  await expect(row).toContainText('Staff');
  const asStaff = await myMembership(member);
  expect(asStaff).toMatchObject({ role: 'staff', role_name: 'Staff' });
  expect((await api(member, 'GET', `/stores/${sid()}/reports/sales`)).status).toBe(200); // staff has reports.view
  const staffRole = await systemRole(shop.s, 'staff');
  expect((await staffRow(shop.s, memberEmail))?.role_id).toBe(staffRole.id);

  await pick(new RegExp(roleName));
  await expect(row).toContainText(roleName);
  expect((await myMembership(member)).role_id).toBe(roleId);
  expect((await api(member, 'GET', `/stores/${sid()}/reports/sales`)).status).toBe(403);
  // Roles card counts the member.
  expect((await roleByName(shop.s, roleName))?.members_count).toBe(1);
  expect((await listRoles(shop.s)).meta).toMatchObject({ custom_roles_used: 1, custom_roles_limit: 20, custom_roles_enabled: true });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('audit: role.created / role.updated / staff.invited / staff.role_changed rows', async () => {
  const r = await api(shop.s, 'GET', '/audit-logs?per_page=50');
  expect(r.status).toBe(200);
  const actions = (r.json.data as Array<{ action: string }>).map((a) => a.action);
  for (const a of ['role.created', 'role.updated', 'staff.invited', 'staff.role_changed']) expect(actions, a).toContain(a);
});
