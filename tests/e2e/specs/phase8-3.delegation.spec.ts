import { expect, test } from '@playwright/test';
import { acceptInvitation, api, deleteE2eUser, signInDashboard, unique, type Session } from '../support/api';
import { createRole, inviteWithRole, shopOn, staffRow, staffUrl, systemRole, watchConsole, type Shop } from '../support/roles';

/**
 * PHASE-8-3 §10 QA `phase8-3.delegation` (§4 N1–N8, S92–S95): a member whose custom role holds only `staff.manage`
 * ("Team lead") can't escalate. UI: Manager and Staff are disabled in the invite modal and the change-role picker with
 * "Has permissions you don’t have"; a Manager row has no actions; the own role is read-only. API: the same actions
 * answer 403 `permission_not_held` / `cannot_edit_own_role` / `cannot_change_own_role`, 409 `system_role_locked`, and
 * the owner role is never assignable (422).
 */
test.describe.configure({ mode: 'serial' });

let shop: Shop;
let lead: Session;
let leadEmail: string;
let leadRole: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let packerRole: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let manager: { email: string; memberId: string; userEmail: string };
let managerInvite: { id: string; email: string };
let packerMember: { email: string; memberId: string };
const users: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  shop = await shopOn('growth', 'deleg');
  leadRole = await createRole(shop.s, `Team lead ${unique('').slice(-4)}`, ['staff.manage']);
  packerRole = await createRole(shop.s, `Packer ${unique('').slice(-4)}`, []); // base access only ⊆ anything
  const admin = await systemRole(shop.s, 'admin');

  const l = await inviteWithRole(shop.s, leadRole.id, 'lead');
  lead = await acceptInvitation(shop.s, l.email, l.mark, 'Team Lead');
  leadEmail = l.email;
  users.push(l.email);

  const m = await inviteWithRole(shop.s, admin.id, 'mgr');
  await acceptInvitation(shop.s, m.email, m.mark, 'Mona Manager');
  users.push(m.email);
  manager = { email: m.email, userEmail: m.email, memberId: (await staffRow(shop.s, m.email))!.id };

  const p = await inviteWithRole(shop.s, packerRole.id, 'packer');
  await acceptInvitation(shop.s, p.email, p.mark, 'Pat Packer');
  users.push(p.email);
  packerMember = { email: p.email, memberId: (await staffRow(shop.s, p.email))!.id };

  const mi = await inviteWithRole(shop.s, admin.id, 'mgr-inv');
  managerInvite = { id: mi.invitation.id, email: mi.email };
});

test.afterAll(async () => {
  for (const u of users) deleteE2eUser(u);
  shop?.cleanup();
});

test('API: N1/N5/N6 — the team lead can’t grant, assign, remove or revoke beyond staff.manage', async () => {
  const admin = await systemRole(shop.s, 'admin');
  const staff = await systemRole(shop.s, 'staff');
  const owner = await systemRole(shop.s, 'owner');

  // N1 (S92): create a role with a key the lead lacks.
  const grant = await api(lead, 'POST', '/roles', { name: unique('Cost peeker '), permissions: ['costs.view'] });
  expect([grant.status, grant.json.error?.code]).toEqual([403, 'permission_not_held']);
  expect(grant.json.error.details.permissions).toEqual(['costs.view']);
  // …and with only keys it holds: allowed (P(role) ⊆ P(actor)).
  const ok = await api(lead, 'POST', '/roles', { name: unique('Lead copy '), permissions: ['staff.manage'] });
  expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  expect((await api(lead, 'DELETE', `/roles/${ok.json.data.id}?revision=${ok.json.data.revision}`)).status).toBe(204);

  // N5 (S93): invite as Manager / Staff.
  for (const r of [admin, staff]) {
    const inv = await api(lead, 'POST', '/staff/invitations', { email: `${unique('esc-')}@e2e.storeplix.test`, role_id: r.id });
    expect([inv.status, inv.json.error?.code], r.name).toEqual([403, 'permission_not_held']);
  }
  // Legacy `role: admin` input is held to the same rule.
  const legacy = await api(lead, 'POST', '/staff/invitations', { email: `${unique('esc-')}@e2e.storeplix.test`, role: 'admin' });
  expect([legacy.status, legacy.json.error?.code]).toEqual([403, 'permission_not_held']);
  // Owner role is never assignable, not even by the owner.
  const asOwner = await api(shop.s, 'PATCH', `/staff/${packerMember.memberId}`, { role_id: owner.id });
  expect([asOwner.status, asOwner.json.error?.code]).toEqual([422, 'validation_failed']);
  expect(Object.keys(asOwner.json.error.details)).toContain('role_id');

  // N5 via change-role: packer → Manager.
  const promote = await api(lead, 'PATCH', `/staff/${packerMember.memberId}`, { role_id: admin.id });
  expect([promote.status, promote.json.error?.code]).toEqual([403, 'permission_not_held']);
  // N6: change / remove a Manager; revoke / resend a Manager invitation.
  const demote = await api(lead, 'PATCH', `/staff/${manager.memberId}`, { role_id: packerRole.id });
  expect([demote.status, demote.json.error?.code]).toEqual([403, 'permission_not_held']);
  const remove = await api(lead, 'DELETE', `/staff/${manager.memberId}`);
  expect([remove.status, remove.json.error?.code]).toEqual([403, 'permission_not_held']);
  const revoke = await api(lead, 'DELETE', `/staff/invitations/${managerInvite.id}`);
  expect([revoke.status, revoke.json.error?.code]).toEqual([403, 'permission_not_held']);
  const resend = await api(lead, 'POST', `/staff/invitations/${managerInvite.id}/resend`);
  expect([resend.status, resend.json.error?.code]).toEqual([403, 'permission_not_held']);

  // N2: a custom role that holds more than the lead can't be edited or deleted by it; `editable` is false for it.
  const big = await createRole(shop.s, unique('Big '), ['costs.view', 'reports.view']);
  const bigEdit = await api(lead, 'PATCH', `/roles/${big.id}`, { revision: big.revision, permissions: [] });
  expect([bigEdit.status, bigEdit.json.error?.code]).toEqual([403, 'permission_not_held']);
  const bigDelete = await api(lead, 'DELETE', `/roles/${big.id}?revision=${big.revision}`);
  expect([bigDelete.status, bigDelete.json.error?.code]).toEqual([403, 'permission_not_held']);
  const asSeen = (await api(lead, 'GET', '/roles')).json.data as Array<{ id: string; editable: boolean }>;
  expect(asSeen.find((r) => r.id === big.id)?.editable).toBe(false);
  expect(asSeen.find((r) => r.id === packerRole.id)?.editable).toBe(true);
  expect(asSeen.find((r) => r.id === leadRole.id)?.editable).toBe(false); // own role
  expect((await api(shop.s, 'DELETE', `/roles/${big.id}?revision=${big.revision}`)).status).toBe(204);
  // System roles: lock comes first.
  const sys = await api(lead, 'PATCH', `/roles/${staff.id}`, { revision: staff.revision, name: 'Hacked' });
  expect([sys.status, sys.json.error?.code]).toEqual([409, 'system_role_locked']);

  // N5 via reassignment: deleting a role the lead may delete, moving its people to Manager / Staff → 403.
  for (const r of [admin, staff]) {
    const viaDelete = await api(lead, 'DELETE', `/roles/${packerRole.id}?revision=${packerRole.revision}&reassign_to=${r.id}`);
    expect([viaDelete.status, viaDelete.json.error?.code], `reassign_to ${r.name}`).toEqual([403, 'permission_not_held']);
  }
  expect((await api(shop.s, 'GET', `/roles/${packerRole.id}`)).status).toBe(200);

  // Allowed: the lead may move the packer into its own role set (⊆) and back.
  const sideways = await api(lead, 'PATCH', `/staff/${packerMember.memberId}`, { role_id: packerRole.id });
  expect(sideways.status, JSON.stringify(sideways.json)).toBe(200);

  // Nothing changed.
  expect((await staffRow(shop.s, manager.email))?.role_id).toBe(admin.id);
  expect((await staffRow(shop.s, managerInvite.email))?.status).toBe('invited');
});

test('API: N3/N7 — nobody edits their own role or membership; N4 system roles locked even for the owner', async () => {
  const self = await api(lead, 'PATCH', `/roles/${leadRole.id}`, { revision: leadRole.revision, permissions: ['staff.manage', 'costs.view'] });
  expect([self.status, self.json.error?.code]).toEqual([403, 'cannot_edit_own_role']);
  const selfDelete = await api(lead, 'DELETE', `/roles/${leadRole.id}?revision=${leadRole.revision}`);
  expect([selfDelete.status, selfDelete.json.error?.code]).toEqual([403, 'cannot_edit_own_role']);
  const me = await staffRow(shop.s, leadEmail);
  const selfMember = await api(lead, 'PATCH', `/staff/${me!.id}`, { role_id: packerRole.id });
  expect([selfMember.status, selfMember.json.error?.code]).toEqual([403, 'cannot_change_own_role']);

  for (const key of ['owner', 'admin', 'staff'] as const) {
    const r = await systemRole(shop.s, key);
    const p = await api(shop.s, 'PATCH', `/roles/${r.id}`, { revision: r.revision, name: `${r.name} x` });
    expect([p.status, p.json.error?.code], `PATCH ${key}`).toEqual([409, 'system_role_locked']);
    const d = await api(shop.s, 'DELETE', `/roles/${r.id}?revision=${r.revision}`);
    expect([d.status, d.json.error?.code], `DELETE ${key}`).toEqual([409, 'system_role_locked']);
  }
  // Unknown and owner-only keys are rejected (S99).
  for (const bad of [['orders.view', 'nuke.all'], ['billing.view', 'billing.manage']]) {
    const r = await api(shop.s, 'POST', '/roles', { name: unique('Bad '), permissions: bad });
    expect([r.status, r.json.error?.code], bad.join()).toEqual([422, 'validation_failed']);
  }
  // Names are unique case-insensitively, system names included.
  const dup = await api(shop.s, 'POST', '/roles', { name: 'manager', permissions: [] });
  expect([dup.status, dup.json.error?.code]).toEqual([422, 'validation_failed']);
});

test('UI: the team lead sees Manager/Staff disabled in the invite modal and the role picker; no actions on a Manager', async ({ page, context }) => {
  test.setTimeout(90_000);
  const c = watchConsole(page);
  await signInDashboard(context, lead);
  await page.goto(staffUrl());
  await expect(page.getByRole('heading', { name: /^Staff$/, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: '+ Invite staff' }).click();
  const modal = page.getByRole('dialog', { name: /Invite staff member/ });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('radio', { name: /Manager/ })).toBeDisabled();
  await expect(modal.getByRole('radio', { name: /^Staff/ })).toBeDisabled();
  await expect(modal.getByText('Has permissions you don’t have')).toHaveCount(2);
  await expect(modal.getByRole('radio', { name: new RegExp(packerRole.name) })).toBeEnabled();
  await expect(modal.getByRole('radio', { name: /Owner/ })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Cancel' }).click();

  // Manager member: no row actions at all (N6).
  const mgrRow = page.getByRole('row').filter({ hasText: manager.email });
  await expect(mgrRow).toBeVisible();
  await expect(mgrRow.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  // Manager invitation: no resend / cancel.
  const invRow = page.getByRole('row').filter({ hasText: managerInvite.email });
  await expect(invRow.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  // Own row: Leave shop only, never Change role (N7).
  const own = page.getByRole('row').filter({ hasText: leadEmail });
  await own.getByRole('button', { name: /^Actions for/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Change role' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Leave shop' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // Packer member: change role lists Manager/Staff disabled.
  const packerRow = page.getByRole('row').filter({ hasText: packerMember.email });
  await packerRow.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Change role' }).click();
  const picker = page.getByRole('dialog', { name: /role$/ });
  await expect(picker.getByRole('radio', { name: /Manager/ })).toBeDisabled();
  await expect(picker.getByRole('radio', { name: /^Staff/ })).toBeDisabled();
  await picker.getByRole('button', { name: 'Cancel' }).click();

  // Own role page is read-only with the banner; matrix has no live checkbox for it.
  await page.goto(staffUrl(`/roles/${leadRole.id}`));
  await expect(page.getByRole('note')).toHaveText(/You can’t edit your own role/);
  await expect(page.getByRole('button', { name: 'Save role' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete role' })).toHaveCount(0);
  for (const sw of await page.getByRole('switch').all()) await expect(sw).toBeDisabled();

  // Creating a role: toggles the lead lacks are disabled.
  await page.goto(staffUrl('/roles/new'));
  await expect(page.getByLabel('Role name')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'See product cost & profit' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Manage staff & roles' })).toBeEnabled();

  expect(c.errors, c.errors.join('\n')).toEqual([]);
});
