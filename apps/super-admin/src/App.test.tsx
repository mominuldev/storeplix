import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App';
import { session } from './lib/session';
import { adminSession, jsonResponse, mockApi, on, renderApp } from './test/utils';

const overview = {
  tenants: { total: 3, active: 3, suspended: 0 },
  subscriptions: { paying: 1, trialing: 1, free: 1, past_due: 0, by_plan: [] },
  past_due: { count: 0, amount: 0, currency: 'BDT' },
  open_invoices: 0,
  domains: { active: 0, pending: 0, failing: 0, suspended: 0 },
  active_impersonations: 0,
  newest_tenants: [],
};
const overviewOk = on('GET', '/admin/overview', () => jsonResponse(200, { data: overview }));

async function typeCode(code: string) {
  const group = await screen.findByRole('group', {
    name: 'Authentication code',
  });
  const boxes = within(group).getAllByRole('textbox');
  await userEvent.click(boxes[0]!);
  await userEvent.paste(code);
}

async function submitCredentials() {
  await userEvent.type(await screen.findByLabelText('Work email'), 'sadia@storeplix.com');
  await userEvent.type(screen.getByLabelText('Password'), 'secret-password');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('super-admin sign-in (Phase 8.1 §3.1)', () => {
  it('redirects anonymous users (GET /admin/auth/me → 401) to the sign-in screen', async () => {
    const api = mockApi([], { session: null });
    renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByRole('heading', { name: 'Sign in to Platform admin' })).toBeInTheDocument();
    expect(api.find('GET', '/admin/auth/me')).toHaveLength(1);
    expect(api.find('GET', '/auth/me')).toHaveLength(0);
  });

  it('validates the work email before calling the API', async () => {
    const api = mockApi([], { session: null });
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter a valid work email')).toBeInTheDocument();
    expect(api.find('POST', '/admin/auth/login')).toHaveLength(0);
  });

  it('shows the expiry message after a 401 and clears the session', async () => {
    session.start({
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    mockApi([], { session: null });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
    expect(session.isSignedIn()).toBe(false);
  });

  it('signs out when the absolute expiry has passed', async () => {
    session.start({ expires_at: new Date(Date.now() - 1000).toISOString() });
    mockApi([], {
      session: {
        ...adminSession(),
        session_expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
  });

  it('password → TOTP → session; CSRF on writes, no X-Tenant-Id, nothing secret stored', async () => {
    document.cookie = 'XSRF-TOKEN=abc%3D';
    let signedIn = false;
    const api = mockApi(
      [
        on('POST', '/admin/auth/login', () =>
          jsonResponse(200, {
            data: { step: 'totp', login_token: 'LT1', expires_at: 'x' },
          }),
        ),
        on('POST', '/admin/auth/totp', () => {
          signedIn = true;
          return jsonResponse(200, { data: adminSession() });
        }),
        on('GET', '/admin/auth/me', () =>
          signedIn
            ? jsonResponse(200, { data: adminSession() })
            : jsonResponse(401, {
                error: { code: 'unauthenticated', message: 'x' },
              }),
        ),
        overviewOk,
      ],
      { session: null },
    );
    renderApp(<AppRoutes />, { route: '/login' });
    await submitCredentials();
    expect(await screen.findByRole('heading', { name: 'Two-factor verification' })).toBeInTheDocument();
    expect(screen.getByText('sadia@storeplix.com')).toBeInTheDocument();
    await typeCode('123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();

    const login = api.find('POST', '/admin/auth/login')[0]!;
    expect(login.body).toEqual({
      email: 'sadia@storeplix.com',
      password: 'secret-password',
    });
    expect(login.headers['X-XSRF-TOKEN']).toBe('abc=');
    expect(login.headers['X-Tenant-Id']).toBeUndefined();
    expect(login.credentials).toBe('same-origin');
    expect(api.find('POST', '/admin/auth/totp')[0]!.body).toEqual({
      login_token: 'LT1',
      code: '123456',
    });
    const stored = [...Object.keys(sessionStorage), ...Object.keys(localStorage)].map((k) => `${k}=${sessionStorage.getItem(k) ?? localStorage.getItem(k)}`);
    expect(stored.join('|')).not.toMatch(/LT1|token/);
  });

  it('shows the attempts-left warning on a wrong code and the lockout copy after the last attempt', async () => {
    let attempts = 0;
    mockApi(
      [
        on('POST', '/admin/auth/login', () =>
          jsonResponse(200, {
            data: { step: 'totp', login_token: 'LT1', expires_at: 'x' },
          }),
        ),
        on('POST', '/admin/auth/totp', () => {
          attempts++;
          return jsonResponse(422, {
            error: {
              code: 'invalid_totp',
              message: 'Wrong code.',
              details: { attempts_left: attempts === 1 ? 4 : 0 },
            },
          });
        }),
      ],
      { session: null },
    );
    renderApp(<AppRoutes />, { route: '/login' });
    await submitCredentials();
    await typeCode('000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('1 incorrect code · 4 attempts left')).toBeInTheDocument();
    await typeCode('111111');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Account locked for 15 minutes')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to Platform admin' })).toBeInTheDocument();
  });

  it('offers the recovery-code option and sends recovery_code instead of code', async () => {
    const api = mockApi(
      [
        on('POST', '/admin/auth/login', () =>
          jsonResponse(200, {
            data: { step: 'totp', login_token: 'LT1', expires_at: 'x' },
          }),
        ),
        on('POST', '/admin/auth/totp', () =>
          jsonResponse(422, {
            error: {
              code: 'invalid_totp',
              message: 'Used.',
              details: { attempts_left: 3 },
            },
          }),
        ),
      ],
      { session: null },
    );
    renderApp(<AppRoutes />, { route: '/login' });
    await submitCredentials();
    await userEvent.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText('Recovery codes have 10 characters')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Recovery code'), 'abcde-12345');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(api.find('POST', '/admin/auth/totp')).toHaveLength(1));
    expect(api.find('POST', '/admin/auth/totp')[0]!.body).toEqual({
      login_token: 'LT1',
      recovery_code: 'abcde12345',
    });
  });

  it('enrols: QR as an <img> data URL (never inline SVG), manual key, then 10 recovery codes gate the session', async () => {
    let signedIn = false;
    const codes = Array.from({ length: 10 }, (_, i) => `CODE${i}ABCDE`.slice(0, 10));
    const api = mockApi(
      [
        on('POST', '/admin/auth/login', () =>
          jsonResponse(200, {
            data: { step: 'enroll', login_token: 'LT2', expires_at: 'x' },
          }),
        ),
        on('GET', '/admin/auth/enroll', () =>
          jsonResponse(200, {
            data: {
              otpauth_uri: 'otpauth://x',
              qr_svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
              secret: 'JBSWY3DPEHPK3PXP',
            },
          }),
        ),
        on('POST', '/admin/auth/enroll', () => {
          signedIn = true;
          return jsonResponse(200, {
            data: adminSession(),
            meta: { recovery_codes: codes },
          });
        }),
        on('GET', '/admin/auth/me', () =>
          signedIn
            ? jsonResponse(200, { data: adminSession() })
            : jsonResponse(401, {
                error: { code: 'unauthenticated', message: 'x' },
              }),
        ),
        overviewOk,
      ],
      { session: null },
    );
    const { container } = renderApp(<AppRoutes />, { route: '/login' });
    await submitCredentials();
    expect(
      await screen.findByRole('heading', {
        name: 'Set up two-factor verification',
      }),
    ).toBeInTheDocument();
    const img = await screen.findByRole('img', {
      name: 'QR code for your authenticator app',
    });
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('svg script')).toBeNull();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expect(api.find('GET', '/admin/auth/enroll')[0]!.url.searchParams.get('login_token')).toBe('LT2');

    await typeCode('654321');
    await userEvent.click(screen.getByRole('button', { name: 'Turn on 2FA and continue' }));
    expect(await screen.findByRole('heading', { name: 'Save your recovery codes' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Recovery codes' })).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Download .txt' })).toBeInTheDocument();
    const go = screen.getByRole('button', {
      name: 'Continue to Platform admin',
    });
    expect(go).toBeDisabled();
    await userEvent.click(screen.getByLabelText('I saved them somewhere safe'));
    await userEvent.click(go);
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    expect(api.find('POST', '/admin/auth/enroll')[0]!.body).toEqual({
      login_token: 'LT2',
      code: '654321',
    });
  });

  it('renders only the built navigation (unbuilt sections are removed; Revenue reports needs view_analytics)', async () => {
    session.start({
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    mockApi([overviewOk]);
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    for (const label of ['Dashboard', 'Merchants', 'Billing', 'Revenue reports', 'Domains', 'Impersonations', 'Team & roles', 'Audit log']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'Revenue reports' })).toHaveAttribute('href', '/revenue');
    for (const label of [
      'Integration health',
      'Risk network',
      'Support tickets',
      'Announcements',
      'Plans & features',
      'Themes & templates',
      'Platform settings',
    ]) {
      expect(within(nav).queryByRole('link', { name: label })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Notifications' })).toBeNull();
    expect(screen.getByText('Super admin · 2FA on')).toBeInTheDocument();
  });

  it('warns when fewer than 3 recovery codes are left', async () => {
    mockApi([overviewOk], {
      session: adminSession('support', { recovery_codes_left: 2 }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText(/Only 2 recovery codes left/)).toBeInTheDocument();
  });
});

describe('/accept-invite', () => {
  it('reads the token from the hash, clears it, and continues to enrolment', async () => {
    const api = mockApi(
      [
        on('GET', '/admin/invitations/tok123', () =>
          jsonResponse(200, {
            data: {
              email: 'new@storeplix.com',
              role: 'support',
              existing_user: false,
            },
          }),
        ),
        on('POST', '/admin/invitations/tok123/accept', () =>
          jsonResponse(200, {
            data: { step: 'enroll', login_token: 'LT9', expires_at: 'x' },
          }),
        ),
        on('GET', '/admin/auth/enroll', () =>
          jsonResponse(200, {
            data: {
              otpauth_uri: 'otpauth://x',
              qr_svg: '<svg/>',
              secret: 'ABCDEFGH',
            },
          }),
        ),
      ],
      { session: null },
    );
    renderApp(<AppRoutes />, { route: '/accept-invite#token=tok123' });
    expect(await screen.findByRole('heading', { name: 'Join Platform admin' })).toBeInTheDocument();
    expect(screen.getByText('new@storeplix.com')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Full name'), 'Nusrat Jahan');
    await userEvent.type(screen.getByLabelText('Password'), 'long-password-1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'long-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to 2FA setup' }));
    expect(await screen.findByText('Passwords don’t match')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Confirm password'));
    await userEvent.type(screen.getByLabelText('Confirm password'), 'long-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to 2FA setup' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Set up two-factor verification',
      }),
    ).toBeInTheDocument();
    expect(api.find('POST', '/admin/invitations/tok123/accept')[0]!.body).toEqual({
      name: 'Nusrat Jahan',
      password: 'long-password-1',
      password_confirmation: 'long-password-1',
    });
  });

  it('shows the unusable-link state without a token', async () => {
    mockApi([], { session: null });
    renderApp(<AppRoutes />, { route: '/accept-invite' });
    expect(
      await screen.findByRole('heading', {
        name: 'This invitation can’t be used',
      }),
    ).toBeInTheDocument();
  });
});
