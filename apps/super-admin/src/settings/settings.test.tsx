import type { PlatformSecuritySettings } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { session } from '../lib/session';
import { adminSession, jsonResponse, mockApi, on, renderApp } from '../test/utils';

// PHASE-8-1 amendment A1 §2 Web: login signed_in step, settings tab toggle + password confirm, banner, nav gating.

const overview = {
  tenants: { total: 0, active: 0, suspended: 0 },
  subscriptions: { paying: 0, trialing: 0, free: 0, past_due: 0, by_plan: [] },
  past_due: { count: 0, amount: 0, currency: 'BDT' },
  open_invoices: 0,
  domains: { active: 0, pending: 0, failing: 0, suspended: 0 },
  active_impersonations: 0,
  newest_tenants: [],
};
const overviewOk = on('GET', '/admin/overview', () => jsonResponse(200, { data: overview }));

function settings(overrides: Partial<PlatformSecuritySettings> = {}): PlatformSecuritySettings {
  return {
    staff_two_factor_required: true,
    environment_default: true,
    source: 'default',
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

const startSession = () => session.start({ expires_at: new Date(Date.now() + 3600_000).toISOString() });

describe('sign-in while staff two-step sign-in is off (A1-3)', () => {
  it('step signed_in goes straight to the app without a TOTP screen', async () => {
    let signedIn = false;
    const s = adminSession('support', { totp_enrolled: false, recovery_codes_left: 0 }, { environment: 'local', security: { staff_two_factor_required: false } });
    const api = mockApi(
      [
        on('POST', '/admin/auth/login', () => {
          signedIn = true;
          return jsonResponse(200, { data: { step: 'signed_in', ...s } });
        }),
        on('GET', '/admin/auth/me', () =>
          signedIn ? jsonResponse(200, { data: s }) : jsonResponse(401, { error: { code: 'unauthenticated', message: 'x' } }),
        ),
        overviewOk,
      ],
      { session: null },
    );
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.type(await screen.findByLabelText('Work email'), 'sadia@storeplix.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Two-factor verification' })).toBeNull();
    expect(api.find('POST', '/admin/auth/totp')).toHaveLength(0);
    expect(session.isSignedIn()).toBe(true);
    // Not enrolled: no "2FA on" label and no "no recovery codes left" warning.
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.queryByText(/recovery codes? left/)).toBeNull();
  });
});

describe('Platform settings navigation (A1-6)', () => {
  it('super admin sees Platform settings → /settings with only the Security tab', async () => {
    startSession();
    mockApi([overviewOk, on('GET', '/admin/settings/security', () => jsonResponse(200, { data: settings() }))]);
    renderApp(<AppRoutes />, { route: '/' });
    const nav = await screen.findByRole('complementary', { name: 'Platform navigation' });
    const link = await within(nav).findByRole('link', { name: 'Platform settings' });
    expect(link).toHaveAttribute('href', '/settings');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Platform settings' })).toBeInTheDocument();
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(sections).getByText('Security')).toBeInTheDocument();
    for (const hidden of ['General', 'Subscription billing', 'Domains & SSL', 'Messaging', 'Email', 'Maintenance', 'Legal']) {
      expect(within(sections).queryByText(hidden)).toBeNull();
    }
  });

  it.each(['support', 'billing', 'read_only'] as const)('%s has no Platform settings item and /settings does not call the API', async (role) => {
    const api = mockApi([overviewOk], { session: adminSession(role) });
    renderApp(<AppRoutes />, { route: '/settings' });
    expect(await screen.findByText('You can’t open platform settings')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform settings' })).toBeNull();
    expect(api.find('GET', '/admin/settings/security')).toHaveLength(0);
  });
});

describe('Security tab (A1-4, A1-5)', () => {
  it('shows the effective value, environment default, source and last change', async () => {
    mockApi([
      on('GET', '/admin/settings/security', () =>
        jsonResponse(200, {
          data: settings({ source: 'setting', updated_at: '2026-11-20T04:00:00Z', updated_by: { id: 'U2', name: 'Rafiq Islam' } }),
        }),
      ),
    ]);
    renderApp(<AppRoutes />, { route: '/settings' });
    const toggle = await screen.findByRole('switch', { name: 'Require two-step sign-in for platform staff' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Default for this environment (production): On')).toBeInTheDocument();
    expect(screen.getByText('Set by a super admin')).toBeInTheDocument();
    expect(screen.getByText(/^Last changed by Rafiq Islam · /)).toBeInTheDocument();
  });

  it('loading then error state with Try again', async () => {
    let fail = true;
    mockApi([
      on('GET', '/admin/settings/security', () =>
        fail ? jsonResponse(500, { error: { code: 'server_error', message: 'Server error.' } }) : jsonResponse(200, { data: settings() }),
      ),
    ]);
    renderApp(<AppRoutes />, { route: '/settings' });
    expect(await screen.findByText('We couldn’t load this')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: 'Require two-step sign-in for platform staff' })).toBeInTheDocument();
  });

  it('turning off outside local: warning, password required, 422 invalid_password on the field, then PATCH + banner', async () => {
    let attempt = 0;
    const api = mockApi([
      on('GET', '/admin/settings/security', () => jsonResponse(200, { data: settings() })),
      on('PATCH', '/admin/settings/security', () => {
        attempt += 1;
        if (attempt === 1)
          return jsonResponse(422, {
            error: { code: 'invalid_password', message: 'The password is incorrect.', details: { current_password: ['The password is incorrect.'] } },
          });
        return jsonResponse(200, {
          data: settings({
            staff_two_factor_required: false,
            source: 'setting',
            updated_at: new Date().toISOString(),
            updated_by: { id: 'U1', name: 'Sadia Ahmed' },
          }),
        });
      }),
    ]);
    renderApp(<AppRoutes />, { route: '/settings' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Require two-step sign-in for platform staff' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Turn off two-step sign-in?')).toBeInTheDocument();
    expect(within(dialog).getByText('This is the production environment')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('Enter your current password')).toBeInTheDocument();
    expect(api.find('PATCH', '/admin/settings/security')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText('Your current password'), 'wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('The password is incorrect.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Your current password')).toHaveAttribute('aria-invalid', 'true');

    await userEvent.clear(within(dialog).getByLabelText('Your current password'));
    await userEvent.type(within(dialog).getByLabelText('Your current password'), 'secret-password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(api.find('PATCH', '/admin/settings/security')[1]!.body).toEqual({ staff_two_factor_required: false, current_password: 'secret-password' });
    expect(screen.getByRole('switch', { name: 'Require two-step sign-in for platform staff' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/^Last changed by Sadia Ahmed · /)).toBeInTheDocument();
    // The session's security block is patched, so the persistent banner shows at once.
    expect(screen.getByText('Two-step sign-in is off for platform staff')).toBeInTheDocument();
  });

  it('local: turning off has no warning; turning on sends true', async () => {
    const api = mockApi(
      [
        on('GET', '/admin/settings/security', () => jsonResponse(200, { data: settings({ staff_two_factor_required: false, environment_default: false }) })),
        on('PATCH', '/admin/settings/security', () => jsonResponse(200, { data: settings({ source: 'setting' }) })),
      ],
      { session: adminSession('super_admin', {}, { environment: 'local', security: { staff_two_factor_required: false } }) },
    );
    renderApp(<AppRoutes />, { route: '/settings' });
    expect(await screen.findByText('Default for this environment (local): Off')).toBeInTheDocument();
    expect(screen.getByText('Environment default')).toBeInTheDocument();
    expect(screen.queryByText('Two-step sign-in is off for platform staff')).toBeNull();

    await userEvent.click(screen.getByRole('switch', { name: 'Require two-step sign-in for platform staff' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Turn on two-step sign-in?')).toBeInTheDocument();
    expect(within(dialog).queryByText(/environment$/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Your current password'), 'secret-password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.find('PATCH', '/admin/settings/security')[0]!.body).toEqual({ staff_two_factor_required: true, current_password: 'secret-password' });
  });

  it('cancel leaves the setting unchanged', async () => {
    const api = mockApi([on('GET', '/admin/settings/security', () => jsonResponse(200, { data: settings() }))]);
    renderApp(<AppRoutes />, { route: '/settings' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Require two-step sign-in for platform staff' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('switch', { name: 'Require two-step sign-in for platform staff' })).toHaveAttribute('aria-checked', 'true');
    expect(api.find('PATCH', '/admin/settings/security')).toHaveLength(0);
  });
});

describe('two-step sign-in off banner (A1-5)', () => {
  const off = { security: { staff_two_factor_required: false } };

  it('super admin outside local sees the persistent banner with a link to settings', async () => {
    mockApi([overviewOk, on('GET', '/admin/settings/security', () => jsonResponse(200, { data: settings({ staff_two_factor_required: false }) }))], {
      session: adminSession('super_admin', {}, { environment: 'staging', ...off }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Two-step sign-in is off for platform staff')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Review security settings' }));
    expect(await screen.findByRole('heading', { name: 'Platform settings' })).toBeInTheDocument();
    expect(screen.getByText('Two-step sign-in is off for platform staff')).toBeInTheDocument();
  });

  it('no banner in local, when on, or without manage_settings', async () => {
    for (const s of [
      adminSession('super_admin', {}, { environment: 'local', ...off }),
      adminSession('super_admin', {}, { environment: 'production' }),
      adminSession('support', {}, { environment: 'production', ...off }),
    ]) {
      const view = (mockApi([overviewOk], { session: s }), renderApp(<AppRoutes />, { route: '/' }));
      expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
      expect(screen.queryByText('Two-step sign-in is off for platform staff')).toBeNull();
      view.unmount();
    }
  });
});
