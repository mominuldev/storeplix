import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import { session } from './lib/session';
import { jsonResponse, renderApp } from './test/utils';

describe('super-admin', () => {

  it('redirects anonymous users (GET /auth/me → 401) to the sign-in screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } })));
    renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByRole('heading', { name: 'Sign in to Platform admin' })).toBeInTheDocument();
  });

  it('validates the work email before calling the API', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter a valid work email')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String((c as unknown[])[0]).includes('/auth/login'))).toBe(false);
  });

  it('shows the expiry message after a 401 and clears the session', async () => {
    session.start({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } })));
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
    expect(session.isSignedIn()).toBe(false);
    expect(sessionStorage.length).toBeGreaterThan(0); // notice lives in sessionStorage
  });

  it('logs out when expires_at has passed', async () => {
    session.start({ expires_at: new Date(Date.now() - 1000).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { id: '1', name: 'Sadia', email: 's@x.co', phone: null, created_at: '' }, meta: { session_expires_at: new Date(Date.now() - 1000).toISOString() } })));
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
  });

  it('renders the platform navigation for an authenticated user', async () => {
    session.start({ expires_at: new Date(Date.now() + 3600_000).toISOString() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/auth/me')
          ? jsonResponse(200, { data: { id: '1', name: 'Sadia Ahmed', email: 's@storeplix.com', phone: null, created_at: '' } })
          : jsonResponse(200, { data: { status: 'ok', version: '0.1.0', time: new Date().toISOString() } }),
      ),
    );
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Merchants' })).toHaveAttribute('href', '/merchants');
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('signs in with a cookie session: CSRF header on login, no token stored anywhere', async () => {
    document.cookie = 'XSRF-TOKEN=abc%3D';
    const calls: { url: string; headers: Record<string, string>; credentials?: RequestCredentials }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials });
        if (String(url).endsWith('/auth/login'))
          return jsonResponse(200, { data: { expires_at: new Date(Date.now() + 3600_000).toISOString(), user: { id: '1', name: 'Sadia Ahmed', email: 's@storeplix.com', phone: null, created_at: '' } } });
        if (String(url).endsWith('/auth/me') && calls.some((c) => c.url.endsWith('/auth/login')))
          return jsonResponse(200, { data: { id: '1', name: 'Sadia Ahmed', email: 's@storeplix.com', phone: null, created_at: '' } });
        if (String(url).endsWith('/auth/me')) return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } });
        return jsonResponse(200, { data: { status: 'ok', version: '0.1.0', time: new Date().toISOString() } });
      }),
    );
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.type(await screen.findByLabelText(/email/i), 's@storeplix.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'password');
    await userEvent.click(screen.getByRole('button', { name: /Continue|Sign in/ }));
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    const login = calls.find((c) => c.url.endsWith('/auth/login'))!;
    expect(login.url).toBe('/api/v1/auth/login');
    expect(login.headers['X-XSRF-TOKEN']).toBe('abc=');
    expect(login.headers.Authorization).toBeUndefined();
    expect(login.credentials).toBe('same-origin');
    const stored = [...Object.keys(sessionStorage), ...Object.keys(localStorage)].map((k) => `${k}=${sessionStorage.getItem(k) ?? localStorage.getItem(k)}`);
    expect(stored.join('|')).not.toMatch(/token/);
  });
});
