import { expect, test } from '@playwright/test';
import { acceptInvitation, api, deleteE2eUser, signInDashboard, unique, type Session } from '../support/api';
import { LABEL, createRole, getRole, inviteWithRole, listRoles, myMembership, shopOn, staffRow, staffUrl, systemRole, watchConsole, type Shop } from '../support/roles';

/**
 * PHASE-8-3 §6.1, §7.2, §7.3 (P83-9, P83-10, S96): role editor flows on a Growth shop.
 *  - delete in use → 409 `role_in_use` with member + invitation ids; UI delete with "Move people to" moves members AND
 *    open invitations atomically; reassign to self / owner / another tenant's role → 422;
 *  - revision conflict in the role detail page and in the Staff matrix → toast + refetch, nothing overwritten;
 *  - Duplicate role → "{name} copy" editor with the same permissions;
 *  - 20 custom roles max → 409 `role_limit_reached`;
 *  - another tenant's role id → 404 on GET/PATCH/DELETE (S96).
 */
test.describe.configure({ mode: 'serial' });

let shop: Shop;
let other: Shop;
let member: Session;
let memberEmail: string;
let inviteEmail: string;
let roleA: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const users: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await shopOn('growth', 'edit');
  other = await shopOn('growth', 'edit-b');
  roleA = await createRole(shop.s, `Packer ${unique('').slice(-4)}`, ['shipments.manage', 'inventory.adjust'], 'Packs parcels');
  const inv = await inviteWithRole(shop.s, roleA.id, 'pk');
  member = await acceptInvitation(shop.s, inv.email, inv.mark, 'Pia Packer');
  memberEmail = inv.email;
  users.push(inv.email);
  inviteEmail = (await inviteWithRole(shop.s, roleA.id, 'pk-open')).email; // stays an open invitation
});

test.afterAll(() => {
  for (const u of users) deleteE2eUser(u);
  shop?.cleanup();
  other?.cleanup();
});

test('API: delete in use → 409 role_in_use with ids; bad reassign targets → 422; foreign role → 404', async () => {
  const detail = await getRole(shop.s, roleA.id);
  expect(detail.members.map((m: { kind: string; status: string }) => `${m.kind}:${m.status}`).sort()).toEqual(['invitation:invited', 'member:active']);
  const r = await api(shop.s, 'DELETE', `/roles/${roleA.id}?revision=${detail.revision}`);
  expect([r.status, r.json.error?.code]).toEqual([409, 'role_in_use']);
  expect(r.json.error.details.members).toHaveLength(1);
  expect(r.json.error.details.invitations).toHaveLength(1);

  const owner = await systemRole(shop.s, 'owner');
  const foreign = await systemRole(other.s, 'staff');
  for (const [label, target] of [['self', roleA.id], ['owner', owner.id], ['foreign', foreign.id], ['unknown', '01JAAAAAAAAAAAAAAAAAAAAAAA']] as const) {
    const bad = await api(shop.s, 'DELETE', `/roles/${roleA.id}?revision=${detail.revision}&reassign_to=${target}`);
    expect([bad.status, bad.json.error?.code], label).toEqual([422, 'validation_failed']);
  }
  // A foreign role_id on invite / change-role is "not found in tenant" (422), never assigned.
  const memberRow = await staffRow(shop.s, memberEmail);
  const cross = await api(shop.s, 'PATCH', `/staff/${memberRow!.id}`, { role_id: foreign.id });
  expect([cross.status, cross.json.error?.code]).toEqual([422, 'validation_failed']);
  // S96: another tenant's role is 404 on every verb.
  const foreignCustom = await createRole(other.s, unique('Theirs '), ['orders.view']);
  expect((await api(shop.s, 'GET', `/roles/${foreignCustom.id}`)).status).toBe(404);
  expect((await api(shop.s, 'PATCH', `/roles/${foreignCustom.id}`, { revision: 1, name: 'x' })).status).toBe(404);
  expect((await api(shop.s, 'DELETE', `/roles/${foreignCustom.id}?revision=${foreignCustom.revision}`)).status).toBe(404);
  expect((await getRole(other.s, foreignCustom.id)).name).toBe(foreignCustom.name);
  // Still intact.
  expect((await getRole(shop.s, roleA.id)).members).toHaveLength(2);
});

test('UI: role detail revision conflict → toast, latest version loaded, other edit kept', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl(`/roles/${roleA.id}`));
  await expect(page.getByRole('heading', { name: roleA.name, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save role' })).toBeDisabled(); // clean
  await page.getByRole('switch', { name: LABEL['reports.view'] }).click();
  await expect(page.getByRole('button', { name: 'Save role' })).toBeEnabled();

  // Someone else saves first.
  const fresh = await getRole(shop.s, roleA.id);
  const theirs = await api(shop.s, 'PATCH', `/roles/${roleA.id}`, { revision: fresh.revision, description: 'Changed elsewhere' });
  expect(theirs.status).toBe(200);

  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/roles/${roleA.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save role' }).click();
  const res = await saved;
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('revision_conflict');
  await expect(page.getByText(/Someone else changed this role/)).toBeVisible();
  await expect(page.getByLabel('Description')).toHaveValue('Changed elsewhere');
  const after = await getRole(shop.s, roleA.id);
  expect(after.permissions).toEqual(['shipments.manage', 'inventory.adjust']);
  expect(after.description).toBe('Changed elsewhere');
  roleA = after;
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('UI: Staff matrix — stage, Discard, then revision conflict on Save changes', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl());
  const matrix = page.getByLabel('Roles & permissions', { exact: true });
  await expect(matrix.getByRole('columnheader', { name: roleA.name })).toBeVisible();
  // System columns locked, custom column live.
  await expect(matrix.getByRole('checkbox', { name: `Manager: ${LABEL['orders.view']}` })).toBeDisabled();
  await expect(matrix.getByRole('checkbox', { name: `Owner: ${LABEL['billing.manage']}` })).toBeChecked();
  const box = matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['orders.refund']}` });
  await expect(box).toBeEnabled();
  await expect(matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['billing.manage']}` })).toBeDisabled();

  // Prerequisites auto-tick, Discard restores.
  await box.check();
  await expect(matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['orders.process']}` })).toBeChecked();
  await expect(matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['orders.view']}` })).toBeChecked();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(box).not.toBeChecked();

  await matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['customers.view']}` }).check();
  const fresh = await getRole(shop.s, roleA.id);
  expect((await api(shop.s, 'PATCH', `/roles/${roleA.id}`, { revision: fresh.revision, name: `${roleA.name}!` })).status).toBe(200);
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/roles/${roleA.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await saved).status()).toBe(409);
  await expect(page.getByText(/Someone else changed a role/)).toBeVisible();
  await expect(matrix.getByRole('columnheader', { name: `${roleA.name}!` })).toBeVisible();
  roleA = await getRole(shop.s, roleA.id);
  expect(roleA.permissions).toEqual(['shipments.manage', 'inventory.adjust']);

  // A clean save works and bumps the revision.
  await matrix.getByRole('checkbox', { name: `${roleA.name}: ${LABEL['customers.view']}` }).check();
  const ok = page.waitForResponse((r) => r.url().endsWith(`/api/v1/roles/${roleA.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect((await ok).status()).toBe(200);
  const now = await getRole(shop.s, roleA.id);
  expect(now.permissions).toEqual(['shipments.manage', 'inventory.adjust', 'customers.view']);
  expect(now.revision).toBe(roleA.revision + 1);
  roleA = now;
  // S97: next request picks it up.
  expect((await myMembership(member)).permissions).toContain('customers.view');
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('UI: Duplicate role, then delete the original with "Move people to" the copy (members + invitations move)', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, shop.s);
  await page.goto(staffUrl(`/roles/${roleA.id}`));
  await page.getByRole('button', { name: 'Duplicate role' }).click();
  await expect(page).toHaveURL(new RegExp(`/staff/roles/new\\?from=${roleA.id}`));
  await expect(page.getByLabel('Role name')).toHaveValue(`${roleA.name} copy`);
  for (const k of roleA.permissions as Array<keyof typeof LABEL>) await expect(page.getByRole('switch', { name: LABEL[k] })).toHaveAttribute('aria-checked', 'true');
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/roles') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create role' }).click();
  const copy = ((await (await created).json()) as { data: { id: string; name: string } }).data;

  await page.goto(staffUrl(`/roles/${roleA.id}`));
  await page.getByRole('button', { name: 'Delete role' }).click();
  const d = page.getByRole('dialog', { name: /^Delete / });
  await expect(d).toContainText('2 people have this role');
  await d.getByLabel('Move people to').selectOption({ label: copy.name });
  const del = page.waitForResponse((r) => r.url().includes(`/api/v1/roles/${roleA.id}`) && r.request().method() === 'DELETE');
  await d.getByRole('button', { name: 'Delete role' }).click();
  expect((await del).status()).toBe(204);
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByRole('row').filter({ hasText: inviteEmail })).toContainText(copy.name);

  expect((await staffRow(shop.s, memberEmail))?.role_id).toBe(copy.id);
  expect((await staffRow(shop.s, inviteEmail))?.role_id).toBe(copy.id);
  expect((await myMembership(member)).role_name).toBe(copy.name);
  expect((await api(shop.s, 'GET', `/roles/${roleA.id}`)).status).toBe(404);
  const audit = await api(shop.s, 'GET', '/audit-logs?per_page=50');
  const deleted = (audit.json.data as Array<{ action: string; meta: Record<string, unknown> }>).find((a) => a.action === 'role.deleted');
  expect(deleted?.meta).toMatchObject({ reassigned_to: { id: copy.id, name: copy.name }, members_moved: 1, invitations_moved: 1 });
  expect(c.errors, c.errors.join('\n')).toEqual([]);
});

test('API: 20 custom roles max → 409 role_limit_reached', async () => {
  test.setTimeout(90_000);
  const used = (await listRoles(shop.s)).meta.custom_roles_used as number;
  for (let i = used; i < 20; i++) await createRole(shop.s, `Limit ${i} ${unique('').slice(-4)}`, []);
  expect((await listRoles(shop.s)).meta.custom_roles_used).toBe(20);
  const r = await api(shop.s, 'POST', '/roles', { name: unique('One more '), permissions: [] });
  expect([r.status, r.json.error?.code]).toEqual([409, 'role_limit_reached']);
});
