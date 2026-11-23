import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { jsonResponse, member, renderApp, signedIn, SYSTEM_ROLE_IDS } from '../test/utils';
import { catalogueResponse, rolesResponse } from './roles.fixtures';

const team = (viewer: 'owner' | 'admin') =>
  jsonResponse(200, {
    data: [
      member({ id: 'O', name: 'Rafiqul Alam', role: 'owner', is_you: viewer === 'owner' }),
      member({ id: 'A', name: 'Sumaiya Akter', role: 'admin', is_you: viewer === 'admin' }),
      member({ id: 'S', name: 'Nusrat Jahan', role: 'staff' }),
      member({ id: 'I', kind: 'invitation', user_id: null, name: 'Tanvir Hasan', email: 'tanvir@shop.com', role: 'staff', status: 'invited', joined_at: null }),
    ],
    meta: { seats_used: 3, seats_limit: 5 },
  });

const staffRoutes = (viewer: 'owner' | 'admin', extra: Parameters<typeof signedIn>[1] = {}) => ({
  'GET /staff': team(viewer),
  'GET /audit-logs': jsonResponse(200, { data: [] }),
  'GET /roles': rolesResponse(),
  'GET /permissions': catalogueResponse(),
  ...extra,
});

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.getByRole('menu');
}

describe('Staff & roles — permission-based UI gating', () => {
  it('members without staff.manage see the no-access state and never call GET /staff or /roles', async () => {
    const api = signedIn('staff');
    renderApp(<AppRoutes />, { route: '/staff' });
    expect(await screen.findByText('You can’t manage staff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Invite staff' })).not.toBeInTheDocument();
    expect(api.mock.calls.some(([u]) => /\/api\/v1\/(staff|roles)$/.test(String(u)))).toBe(false);
  });

  it('a manager cannot act on the owner, can change/remove staff, and can only leave for themselves', async () => {
    signedIn('admin', staffRoutes('admin'));
    renderApp(<AppRoutes />, { route: '/staff' });
    expect(await screen.findByText('3 of 5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Rafiqul Alam' })).not.toBeInTheDocument();

    let menu = await openMenu('Nusrat Jahan');
    expect(within(menu).getByRole('menuitem', { name: 'Change role' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Remove from shop' })).toBeInTheDocument();

    menu = await openMenu('Sumaiya Akter');
    expect(within(menu).queryByRole('menuitem', { name: 'Change role' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Leave shop' })).toBeInTheDocument();

    menu = await openMenu('Tanvir Hasan');
    expect(within(menu).getByRole('menuitem', { name: 'Resend invite' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Cancel invite' })).toBeInTheDocument();
  });

  it('changes a role with PATCH /staff/{member} {role_id}', async () => {
    let patched: unknown;
    signedIn(
      'owner',
      staffRoutes('owner', {
        'PATCH /staff/S': (init) => {
          patched = JSON.parse(String(init.body));
          return jsonResponse(200, { data: member({ id: 'S', role: 'admin' }) });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff' });
    const menu = await openMenu('Nusrat Jahan');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Change role' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).queryByLabelText(/^Owner/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText(/Manager/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save role', hidden: true }));
    await waitFor(() => expect(patched).toEqual({ role_id: SYSTEM_ROLE_IDS.admin }));
  });

  it('invites by email with role_id and surfaces the seat limit (402)', async () => {
    let body: unknown;
    signedIn(
      'owner',
      staffRoutes('owner', {
        'POST /staff/invitations': (init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(402, { error: { code: 'plan_limit_reached', message: 'Limit', details: { staff_seats: ['Your plan allows 5 staff_seats.'] } } });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/staff' });
    await userEvent.click(await screen.findByRole('button', { name: '+ Invite staff' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@shop.com');
    await userEvent.click(within(dialog).getByLabelText(/Manager/));
    await userEvent.click(screen.getByRole('button', { name: 'Send invite', hidden: true }));
    expect(await within(dialog).findByText('Your plan allows 5 staff_seats.')).toBeInTheDocument();
    expect(body).toEqual({ email: 'new@shop.com', name: null, role_id: SYSTEM_ROLE_IDS.admin });
  });
});
