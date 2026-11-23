import { expect, test } from '@playwright/test';
import { acceptInvitation, api, deleteE2eUser, signInDashboard, unique, type Session } from '../support/api';
import { setPlan } from '../support/commerce';
import { createRole, inviteWithRole, listRoles, myMembership, shopOn, staffRow, staffUrl, systemRole, watchConsole, type Shop } from '../support/roles';

/**
 * PHASE-8-3 §10 QA `phase8-3.plan` (P83-8, N9, Q113, S98):
 *  - A Free shop sees the upgrade prompt on "+ Custom role" (header and Roles card) and on a /staff/roles/new deep link;
 *    the API answers 402 `feature_not_in_plan` with `upgrade_plan: ["growth"]`; the invite modal lists no custom roles.
 *  - A Growth shop that downgrades keeps its custom role assigned and enforced (exactly P(role)); create / edit / assign
 *    → 402; list, view and delete-with-reassign to a system role still work; the matrix shows the "Growth plan" note.
 */

test.describe('Free shop', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: Shop;
  test.beforeAll(async () => {
    test.setTimeout(60_000);
    shop = await shopOn('free', 'free');
  });
  test.afterAll(() => shop?.cleanup());

  test('API: system roles listed, custom roles 402 with upgrade_plan growth', async () => {
    const { data, meta } = await listRoles(shop.s);
    expect(data.map((r) => r.key)).toEqual(['owner', 'admin', 'staff']);
    expect(meta).toMatchObject({ custom_roles_used: 0, custom_roles_limit: 20, custom_roles_enabled: false });
    const r = await api(shop.s, 'POST', '/roles', { name: 'Order staff', permissions: ['orders.view'] });
    expect([r.status, r.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    expect(r.json.error.details.upgrade_plan).toEqual(['growth']);
    // System roles still assignable on Free.
    const staff = await systemRole(shop.s, 'staff');
    const inv = await api(shop.s, 'POST', '/staff/invitations', { email: `${unique('free-')}@e2e.storeplix.test`, role_id: staff.id });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect((await api(shop.s, 'DELETE', `/staff/invitations/${inv.json.data.id}`)).status).toBe(204);
  });

  test('UI: "+ Custom role" opens the upgrade prompt; the deep link shows it too; invite lists system roles only', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    await page.goto(staffUrl());
    await expect(page.getByRole('heading', { name: /^Staff$/, level: 1 })).toBeVisible();
    await page.getByLabel('Roles', { exact: true }).getByRole('button', { name: '+ Custom role' }).click();
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible();
    await expect(d).toContainText(/Growth plan/);
    await expect(d.getByRole('button', { name: 'Upgrade to Growth' })).toBeVisible();
    await expect(page).toHaveURL(/\/staff$/); // no editor
    await d.getByRole('button', { name: /Cancel|Not now|Close/ }).first().click();

    // Matrix: system columns only, all read-only.
    const matrix = page.getByLabel('Roles & permissions', { exact: true });
    await expect(matrix.getByRole('columnheader')).toHaveText([/Permission/i, /Owner/i, /Manager/i, /Staff/i]);
    for (const box of await matrix.getByRole('checkbox').all()) await expect(box).toBeDisabled();

    await page.getByRole('button', { name: '+ Invite staff' }).click();
    const modal = page.getByRole('dialog', { name: /Invite staff member/ });
    await expect(modal.getByRole('radio')).toHaveCount(2);
    await modal.getByRole('button', { name: 'Cancel' }).click();

    await page.goto(staffUrl('/roles/new'));
    await expect(page.getByRole('region', { name: 'Upgrade for custom roles' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Upgrade to Growth' })).toHaveAttribute('href', /\/settings\/plan\?upgrade=growth/);
    await expect(page.getByLabel('Role name')).toHaveCount(0);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});

test.describe('Growth shop downgraded to Free', () => {
  test.describe.configure({ mode: 'serial' });
  let shop: Shop;
  let role: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let member: Session;
  let memberEmail: string;
  let otherMemberId: string;
  let otherEmail: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    shop = await shopOn('growth', 'down');
    role = await createRole(shop.s, `Order staff ${unique('').slice(-4)}`, ['orders.view', 'orders.process']);
    const inv = await inviteWithRole(shop.s, role.id, 'down');
    member = await acceptInvitation(shop.s, inv.email, inv.mark, 'Down Member');
    memberEmail = inv.email;
    const staff = await systemRole(shop.s, 'staff');
    const other = await inviteWithRole(shop.s, staff.id, 'other');
    await acceptInvitation(shop.s, other.email, other.mark, 'Other Member');
    otherEmail = other.email;
    otherMemberId = (await staffRow(shop.s, other.email))!.id;
    setPlan(shop.s, 'free');
  });
  test.afterAll(() => {
    for (const e of [memberEmail, otherEmail]) if (e) deleteE2eUser(e);
    shop?.cleanup();
  });

  test('API (S98): the custom role stays assigned and enforced exactly; writes and assignment → 402', async () => {
    const m = await myMembership(member);
    expect(m).toMatchObject({ role: 'custom', role_id: role.id, permissions: ['orders.view', 'orders.process'] });
    expect((await api(member, 'GET', `/stores/${shop.s.storeId}/orders`)).status).toBe(200);
    // Not escalated to Staff (which would have customers.view).
    expect((await api(member, 'GET', `/stores/${shop.s.storeId}/customers`)).status).toBe(403);

    const { meta } = await listRoles(shop.s);
    expect(meta).toMatchObject({ custom_roles_used: 1, custom_roles_enabled: false });
    expect((await api(shop.s, 'GET', `/roles/${role.id}`)).status).toBe(200);
    const patch = await api(shop.s, 'PATCH', `/roles/${role.id}`, { revision: role.revision, name: 'Renamed' });
    expect([patch.status, patch.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const create = await api(shop.s, 'POST', '/roles', { name: unique('New '), permissions: [] });
    expect([create.status, create.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const assign = await api(shop.s, 'PATCH', `/staff/${otherMemberId}`, { role_id: role.id });
    expect([assign.status, assign.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    const invite = await api(shop.s, 'POST', '/staff/invitations', { email: `${unique('d-')}@e2e.storeplix.test`, role_id: role.id });
    expect([invite.status, invite.json.error?.code]).toEqual([402, 'feature_not_in_plan']);
    // Delete with reassignment to a CUSTOM target would be an assignment → 402 (no other custom role exists; the
    // in-use guard answers first without reassign_to).
    const inUse = await api(shop.s, 'DELETE', `/roles/${role.id}?revision=${role.revision}`);
    expect([inUse.status, inUse.json.error?.code]).toEqual([409, 'role_in_use']);
  });

  test('UI: read-only custom role with the Growth note; delete with reassignment to Staff still works', async ({ page, context }) => {
    test.setTimeout(90_000);
    const c = watchConsole(page);
    await signInDashboard(context, shop.s);
    await page.goto(staffUrl());
    const matrix = page.getByLabel('Roles & permissions', { exact: true });
    await expect(matrix).toContainText('Growth plan');
    for (const box of await matrix.getByRole('checkbox').all()) await expect(box).toBeDisabled();

    await page.goto(staffUrl(`/roles/${role.id}`));
    await expect(page.getByRole('heading', { name: role.name, level: 1 })).toBeVisible();
    await expect(page.getByRole('note')).toContainText(/Growth plan/);
    for (const sw of await page.getByRole('switch').all()) await expect(sw).toBeDisabled();
    await page.getByRole('button', { name: 'Delete role' }).click();
    const d = page.getByRole('dialog', { name: /^Delete / });
    await expect(d).toContainText('1 person has this role');
    const move = d.getByLabel('Move people to');
    // Custom targets are not offered without the feature; owner never.
    await expect(move.locator('option', { hasText: 'Owner' })).toHaveCount(0);
    await move.selectOption({ label: 'Staff' });
    const del = page.waitForResponse((r) => r.url().includes(`/api/v1/roles/${role.id}`) && r.request().method() === 'DELETE');
    await d.getByRole('button', { name: 'Delete role' }).click();
    const res = await del;
    expect(res.status()).toBe(204);
    expect(new URL(res.url()).searchParams.get('reassign_to')).toBe((await systemRole(shop.s, 'staff')).id);
    await expect(page).toHaveURL(/\/staff$/);

    const m = await myMembership(member);
    expect(m).toMatchObject({ role: 'staff', role_name: 'Staff' });
    expect((await listRoles(shop.s)).meta.custom_roles_used).toBe(0);
    expect(c.errors, c.errors.join('\n')).toEqual([]);
  });
});
