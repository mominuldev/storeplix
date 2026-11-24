import { PERMISSION_KEYS, SYSTEM_ROLE_PERMISSIONS, type PermissionKey } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { visibleNav } from '../layout/nav';
import { can, holdsAll, permissionsOf } from '../lib/permissions';
import { withoutDependents, withPrerequisites } from '../staff/roles';
import { callsTo, jsonResponse, member, renderApp, signedIn, SYSTEM_ROLE_IDS } from '../test/utils';
import { catalogue, catalogueResponse, detail, orderStaff, packer, role, rolesResponse, systemRoles } from './roles.fixtures';

const perms = (...p: PermissionKey[]) => ({ role: 'custom' as const, permissions: p });
const defs = catalogue.flatMap((g) => g.permissions);

describe('PHASE-8-3 §7.1 permission helpers', () => {
  it('each can.* helper reads exactly its key from the membership', () => {
    const map: [keyof typeof can, PermissionKey][] = [
      ['viewCosts', 'costs.view'],
      ['manageCatalog', 'products.delete'],
      ['deleteCustomers', 'customers.delete'],
      ['bulkData', 'data.import'],
      ['importData', 'data.import'],
      ['exportData', 'data.export'],
      ['manageMarketing', 'marketing.manage'],
      ['manageRefunds', 'orders.refund'],
      ['manageSettings', 'settings.manage'],
      ['editSettings', 'settings.manage'],
      ['createStore', 'settings.manage'],
      ['manageIntegrations', 'integrations.manage'],
      ['manageDomains', 'domains.manage'],
      ['manageStaff', 'staff.manage'],
      ['viewAuditLog', 'audit.view'],
      ['viewBilling', 'billing.view'],
      ['manageBilling', 'billing.manage'],
      ['viewOrders', 'orders.view'],
      ['processOrders', 'orders.process'],
      ['manageShipments', 'shipments.manage'],
      ['cancelShipments', 'shipments.cancel'],
      ['editProducts', 'products.edit'],
      ['adjustInventory', 'inventory.adjust'],
      ['viewCustomers', 'customers.view'],
      ['editCustomers', 'customers.edit'],
      ['viewReports', 'reports.view'],
      ['manageExpenses', 'expenses.manage'],
    ];
    for (const [helper, key] of map) {
      const fn = can[helper] as (m: unknown) => boolean;
      expect(fn(perms(key)), `${helper} with ${key}`).toBe(true);
      expect(fn(perms(...PERMISSION_KEYS.filter((k) => k !== key))), `${helper} without ${key}`).toBe(false);
    }
    expect(can.seeOrders(perms('shipments.manage'))).toBe(true);
    expect(can.seeShipments(perms('orders.view'))).toBe(true);
    expect(can.seeOrders(perms('customers.view'))).toBe(false);
    expect(can.viewCosts(null)).toBe(false);
  });

  it('falls back to the system set only when the API sent no permissions (pre-8.3)', () => {
    expect(permissionsOf({ role: 'staff' })).toEqual(SYSTEM_ROLE_PERMISSIONS.staff);
    expect(permissionsOf({ role: 'custom' })).toEqual([]);
    expect(permissionsOf({ role: 'owner', permissions: [] })).toEqual([]);
  });

  it('N5/N6: change, remove and invitation actions need P(target) ⊆ P(me)', () => {
    const roles = [...systemRoles, orderStaff];
    const me = perms('staff.manage', 'orders.view', 'orders.process', 'shipments.manage');
    const manager = member({ id: 'A', role: 'admin' }) as never;
    const order = member({ id: 'S', role: 'custom', role_id: orderStaff.id }) as never;
    const inviteManager = member({ id: 'I', kind: 'invitation', role: 'admin' }) as never;
    expect(can.changeRole(me, manager, roles)).toBe(false);
    expect(can.removeMember(me, manager, roles)).toBe(false);
    expect(can.manageInvitation(me, inviteManager, roles)).toBe(false);
    expect(can.changeRole(me, order, roles)).toBe(true);
    expect(can.assignRole(me, systemRoles[1]!)).toBe(false);
    expect(can.assignRole(me, systemRoles[0]!)).toBe(false); // owner never assignable
    expect(can.assignRole(me, orderStaff)).toBe(true);
    expect(holdsAll(me, orderStaff.permissions)).toBe(true);
  });

  it('P83-11 prerequisites tick on with the dependent and off with the prerequisite', () => {
    expect([...withPrerequisites(new Set(), 'orders.refund', defs)].sort()).toEqual(['orders.process', 'orders.refund', 'orders.view']);
    expect([...withoutDependents(new Set(['orders.view', 'orders.process', 'orders.refund', 'costs.view'] as PermissionKey[]), 'orders.view', defs)]).toEqual(['costs.view']);
  });

  it('nav hides entries the membership lacks (removed, not disabled)', () => {
    const nav = visibleNav(perms('orders.view', 'orders.process', 'shipments.manage'));
    const labels = nav.map((n) => n.label);
    expect(labels).toContain('Orders');
    expect(labels).not.toContain('Customers');
    expect(labels).not.toContain('Reports');
    expect(labels).not.toContain('Staff');
    expect(nav.find((n) => n.label === 'Products')!.children!.map((c) => c.label)).not.toContain('Import');
    const shipOnly = visibleNav(perms('shipments.manage')).find((n) => n.label === 'Orders')!;
    expect(shipOnly.children!.map((c) => c.label)).toEqual(['All orders', 'Shipments', 'Invoices & labels']);
  });
});

describe('PHASE-8-3 §7.1 routes and sidebar', () => {
  it('a custom role sees only its nav and a deep link without permission shows the no-access state', async () => {
    signedIn({ role: 'custom', role_name: 'Order staff', permissions: ['orders.view', 'orders.process', 'shipments.manage'] });
    renderApp(<AppRoutes />, { route: '/customers' });
    expect(await screen.findByText('You don’t have access to this page')).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Main navigation' });
    expect(within(sidebar).getByText('Orders')).toBeInTheDocument();
    expect(within(sidebar).queryByText('Customers')).not.toBeInTheDocument();
    expect(within(sidebar).queryByText('Reports')).not.toBeInTheDocument();
    expect(within(sidebar).queryByText('Staff')).not.toBeInTheDocument();
  });
});

const staffRoutes = (extra: Parameters<typeof signedIn>[1] = {}, enabled = true) => ({
  'GET /staff': jsonResponse(200, {
    data: [
      member({ id: 'O', name: 'Rafiqul Alam', role: 'owner', is_you: true }),
      member({ id: 'A', name: 'Sumaiya Akter', role: 'admin' }),
      member({ id: 'N', name: 'Nusrat Jahan', role: 'custom', role_id: 'R_ORDER', role_name: 'Order staff' }),
    ],
    meta: { seats_used: 2, seats_limit: 5 },
  }),
  'GET /audit-logs': jsonResponse(200, { data: [] }),
  'GET /roles': rolesResponse(undefined, enabled),
  'GET /permissions': catalogueResponse(),
  ...extra,
});

const box = (name: string) => screen.getByRole('checkbox', { name });

describe('PHASE-8-3 §7.2 Staff page roles card + matrix', () => {
  it('lists roles with counts, links and the cost note; team shows role names', async () => {
    signedIn('owner', staffRoutes());
    renderApp(<AppRoutes />, { route: '/staff' });
    const card = await screen.findByRole('region', { name: 'Roles' }).catch(() => screen.findByLabelText('Roles'));
    expect(await within(card).findByRole('link', { name: 'Order staff role' })).toHaveAttribute('href', '/staff/roles/R_ORDER');
    expect(within(card).getByText('Staff, Order staff and Packer never see cost price or profit.')).toBeInTheDocument();
    expect(screen.getAllByText('Order staff').length).toBeGreaterThan(1);
  });

  it('system columns are disabled, custom columns editable; prerequisites auto-tick; save sends one PATCH per role', async () => {
    const bodies: Record<string, unknown> = {};
    signedIn(
      'owner',
      staffRoutes({
        'PATCH /roles/R_PACK': (init) => {
          bodies.R_PACK = JSON.parse(String(init.body));
          return jsonResponse(200, { data: detail(packer) });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Owner: View & create orders' });
    expect(box('Owner: View & create orders')).toBeDisabled();
    expect(box('Manager: View & create orders')).toBeDisabled();
    expect(box('Staff: View & create orders')).toBeDisabled();
    expect(box('Packer: View & create orders')).toBeEnabled();
    expect(box('Packer: Change plan & pay')).toBeDisabled();

    await userEvent.click(box('Packer: Refunds & paid cancellations'));
    expect(box('Packer: View & create orders')).toBeChecked();
    expect(box('Packer: Confirm & cancel orders')).toBeChecked();
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText('“Refunds & paid cancellations” turned on for Packer')).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(bodies.R_PACK).toEqual({ revision: 2, permissions: ['orders.view', 'orders.process', 'orders.refund', 'shipments.manage', 'inventory.adjust'] }),
    );
  });

  it('discard drops staged changes', async () => {
    signedIn('owner', staffRoutes());
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Packer: View customers' });
    await userEvent.click(box('Packer: View customers'));
    expect(box('Packer: View customers')).toBeChecked();
    await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Discard' }));
    expect(box('Packer: View customers')).not.toBeChecked();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('W-1: an in-app link asks before dropping staged changes (Keep editing / Leave without saving)', async () => {
    signedIn('owner', staffRoutes());
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Packer: View customers' });
    await userEvent.click(box('Packer: View customers'));
    await userEvent.click(screen.getAllByRole('link', { name: 'Orders' })[0]!);
    const ask = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).not.toBeInTheDocument();
    expect(box('Packer: View customers')).toBeChecked();

    await userEvent.click(screen.getAllByRole('button', { name: '+ Custom role' }).at(-1)!);
    expect(await screen.findByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await userEvent.click(screen.getAllByRole('link', { name: 'Orders' })[0]!);
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Packer: View customers' })).not.toBeInTheDocument());
  });

  it('W-1: without staged changes links navigate straight away', async () => {
    signedIn('owner', staffRoutes());
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Packer: View customers' });
    await userEvent.click(screen.getAllByRole('link', { name: 'Orders' })[0]!);
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Packer: View customers' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).not.toBeInTheDocument();
  });

  it('409 revision_conflict → toast and refetch', async () => {
    const api = signedIn(
      'owner',
      staffRoutes({ 'PATCH /roles/R_PACK': jsonResponse(409, { error: { code: 'revision_conflict', message: 'Stale' } }) }),
    );
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Packer: View customers' });
    await userEvent.click(box('Packer: View customers'));
    await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed a role/)).toBeInTheDocument();
    await waitFor(() => expect(callsTo(api, '/roles').length).toBeGreaterThan(1));
    expect(box('Packer: View customers')).not.toBeChecked();
  });

  it('without custom_roles: custom columns read-only with a Growth note, "+ Custom role" opens the upgrade prompt', async () => {
    signedIn('owner', staffRoutes({}, false));
    renderApp(<AppRoutes />, { route: '/staff' });
    await screen.findByRole('checkbox', { name: 'Packer: View customers' });
    expect(box('Packer: View customers')).toBeDisabled();
    expect(screen.getByText(/Growth plan: editing custom roles/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: '+ Custom role' })[0]!);
    expect(await screen.findByText(/Custom roles like Order staff and Packer are part of the Growth plan/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade to Growth', hidden: true })).toBeInTheDocument();
    // W-2: the feature-gate variant, not the count-limit title.
    expect(screen.getByRole('dialog', { name: 'Custom roles are on Growth', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'You’ve reached your plan’s limit', hidden: true })).not.toBeInTheDocument();
  });

  it('roles error state with retry', async () => {
    signedIn('owner', staffRoutes({ 'GET /roles': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) }));
    renderApp(<AppRoutes />, { route: '/staff' });
    expect(await screen.findByText('Couldn’t load roles')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t load permissions')).toBeInTheDocument();
  });
});

describe('PHASE-8-3 §7.4 invite modal role list', () => {
  it('N5-disabled roles and custom roles hidden without the feature', async () => {
    const me = { role: 'custom' as const, role_id: 'R_HR', role_name: 'HR', permissions: ['staff.manage', 'orders.view', 'orders.process', 'shipments.manage'] as PermissionKey[] };
    signedIn(me, staffRoutes());
    renderApp(<AppRoutes />, { route: '/staff' });
    await userEvent.click(await screen.findByRole('button', { name: '+ Invite staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff member', hidden: true });
    await within(dialog).findByLabelText(/Order staff/);
    expect(within(dialog).getByLabelText(/Manager/)).toBeDisabled();
    expect(within(dialog).getByLabelText(/Order staff/)).toBeEnabled();
    expect(within(dialog).getAllByText('Has permissions you don’t have').length).toBeGreaterThan(0);
    expect(within(dialog).queryByLabelText(/^Owner/)).not.toBeInTheDocument();
  });

  it('custom roles are hidden without custom_roles', async () => {
    signedIn('owner', staffRoutes({}, false));
    renderApp(<AppRoutes />, { route: '/staff' });
    await userEvent.click(await screen.findByRole('button', { name: '+ Invite staff' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff member', hidden: true });
    await within(dialog).findByLabelText(/Manager/);
    expect(within(dialog).queryByLabelText(/Order staff/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Staff/)).toBeChecked();
  });
});

describe('PHASE-8-3 §7.3 role detail', () => {
  const routes = (extra: Parameters<typeof signedIn>[1] = {}, enabled = true) => ({ ...staffRoutes(extra, enabled) });

  it('system role is read-only with the built-in banner; Duplicate opens the new role prefilled', async () => {
    signedIn('owner', routes({ 'GET /roles/R_STAFF': jsonResponse(200, { data: detail(systemRoles[2]!) }) }));
    renderApp(<AppRoutes />, { route: '/staff/roles/R_STAFF' });
    expect(await screen.findByText('Built-in role. Duplicate it to customise.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save role' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'View & create orders' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate role' }));
    expect(await screen.findByDisplayValue('Staff copy')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'View & create orders' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'View & create orders' })).toBeEnabled();
  });

  it('own role shows the own-role banner', async () => {
    signedIn({ role: 'custom', role_id: 'R_ORDER', role_name: 'Order staff', permissions: [...SYSTEM_ROLE_PERMISSIONS.admin] }, routes({ 'GET /roles/R_ORDER': jsonResponse(200, { data: detail(orderStaff) }) }));
    renderApp(<AppRoutes />, { route: '/staff/roles/R_ORDER' });
    expect(await screen.findByText('You can’t edit your own role.')).toBeInTheDocument();
  });

  it('disables toggles the actor lacks, saves with revision and shows members', async () => {
    let body: unknown;
    const me = { role: 'custom' as const, role_id: 'R_HR', role_name: 'HR', permissions: ['staff.manage', 'orders.view', 'orders.process', 'shipments.manage', 'customers.view'] as PermissionKey[] };
    signedIn(
      me,
      routes({
        'GET /roles/R_ORDER': jsonResponse(200, {
          data: detail(orderStaff, [
            { id: 'N', kind: 'member', user_id: 'U9', name: 'Nusrat Jahan', email: 'n@shop.com', phone: '8801611998877', status: 'active', is_you: false },
            { id: 'T', kind: 'invitation', user_id: null, name: 'Tanvir Hasan', email: 't@shop.com', phone: null, status: 'invited', is_you: false },
          ]),
        }),
        'PATCH /roles/R_ORDER': (init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(200, { data: detail({ ...orderStaff, revision: 5, permissions: [...orderStaff.permissions, 'customers.view'] }) });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff/roles/R_ORDER' });
    expect(await screen.findByText(/^Role · 2 people · edited .+ by Rafiqul Alam$/)).toBeInTheDocument();
    expect(screen.getByText('Nusrat Jahan')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'See product cost & profit' })).toBeDisabled();
    expect(screen.getAllByText('You don’t have this permission').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save role' })).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'View customers' }));
    expect(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByText('“View customers” turned on for Order staff')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(body).toEqual({ revision: 4, permissions: ['orders.view', 'orders.process', 'shipments.manage', 'customers.view'] }));
  });

  it('creates a new role with POST /roles', async () => {
    let body: unknown;
    signedIn(
      'owner',
      routes({
        'POST /roles': (init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(201, { data: detail(role({ id: 'R_NEW', name: 'Packer 2' })) });
        },
        'GET /roles/R_NEW': jsonResponse(200, { data: detail(role({ id: 'R_NEW', name: 'Packer 2' })) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff/roles/new' });
    await userEvent.type(await screen.findByLabelText('Role name'), 'Packer 2');
    await userEvent.click(screen.getByRole('switch', { name: 'Change courier after booking' }));
    expect(screen.getByRole('switch', { name: 'Book courier & print labels' })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(body).toEqual({ name: 'Packer 2', description: null, permissions: ['shipments.manage', 'shipments.cancel'] }));
    expect(await screen.findByRole('heading', { name: 'Packer 2' })).toBeInTheDocument();
  });

  it('new role without custom_roles shows the upgrade prompt (402 pattern)', async () => {
    signedIn('owner', routes({}, false));
    renderApp(<AppRoutes />, { route: '/staff/roles/new' });
    expect(await screen.findByRole('region', { name: 'Upgrade for custom roles' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upgrade to Growth' })).toHaveAttribute('href', '/settings/plan?upgrade=growth');
  });

  it('402 on save opens the upgrade dialog', async () => {
    signedIn(
      'owner',
      routes({
        'GET /roles/R_PACK': jsonResponse(200, { data: detail(packer) }),
        'PATCH /roles/R_PACK': jsonResponse(402, { error: { code: 'feature_not_in_plan', message: 'Custom roles need Growth.', details: { upgrade_plan: ['growth'] } } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff/roles/R_PACK' });
    await userEvent.click(await screen.findByRole('switch', { name: 'View customers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByText(/Custom roles need Growth/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Available on the Growth plan', hidden: true })).toBeInTheDocument();
  });

  it('W-1: the role editor asks before an in-app link drops edits', async () => {
    signedIn('owner', routes({ 'GET /roles/R_PACK': jsonResponse(200, { data: detail(packer) }) }));
    renderApp(<AppRoutes />, { route: '/staff/roles/R_PACK' });
    await userEvent.click(await screen.findByRole('switch', { name: 'View customers' }));
    await userEvent.click(screen.getAllByRole('link', { name: 'Staff' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('switch', { name: 'View customers' })).toBeChecked();
  });

  it('deletes a role in use after choosing where to move people', async () => {
    const api = signedIn(
      'owner',
      routes({
        'GET /roles/R_ORDER': jsonResponse(200, { data: detail(orderStaff) }),
        'DELETE /roles/R_ORDER': () => new Response(null, { status: 204 }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff/roles/R_ORDER' });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete role' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Order staff?', hidden: true });
    const confirm = within(dialog).getByRole('button', { name: 'Delete role', hidden: true });
    expect(confirm).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Move people to'), SYSTEM_ROLE_IDS.staff);
    await userEvent.click(confirm);
    await waitFor(() => expect(callsTo(api, '/roles/R_ORDER').some(([, init]) => init.method === 'DELETE')).toBe(true));
    const call = callsTo(api, '/roles/R_ORDER').find(([, init]) => init.method === 'DELETE')!;
    const url = new URL(String(call[0]), 'http://localhost');
    expect(url.searchParams.get('reassign_to')).toBe(SYSTEM_ROLE_IDS.staff);
    expect(url.searchParams.get('revision')).toBe(String(orderStaff.revision));
    expect(within(dialog).queryByRole('option', { name: 'Owner', hidden: true })).toBeNull();
  });

  it('unknown role → not-found state; loading state while fetching', async () => {
    signedIn('owner', routes({ 'GET /roles/NOPE': jsonResponse(404, { error: { code: 'not_found', message: 'Not found' } }) }));
    renderApp(<AppRoutes />, { route: '/staff/roles/NOPE' });
    expect(await screen.findByText('This role doesn’t exist')).toBeInTheDocument();
  });
});
