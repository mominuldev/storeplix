import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import { session } from './lib/session';
import { jsonResponse, renderApp } from './test/utils';

describe('super-admin', () => {

  it('redirects anonymous users to the sign-in screen', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderApp(<AppRoutes />, { route: '/merchants' });
    expect(await screen.findByRole('heading', { name: 'Sign in to Platform admin' })).toBeInTheDocument();
  });

  it('validates the work email before calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderApp(<AppRoutes />, { route: '/login' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter a valid work email')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the expiry message after a 401 and clears the session', async () => {
    session.setAuth({ token: 'revoked', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } })));
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
    expect(session.getToken()).toBeNull();
    expect(sessionStorage.length).toBeGreaterThan(0); // notice lives in sessionStorage
  });

  it('logs out when expires_at has passed', async () => {
    session.setAuth({ token: 'old', expires_at: new Date(Date.now() - 1000).toISOString() });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { id: '1', name: 'Sadia', email: 's@x.co', phone: null, created_at: '' } })));
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('Your session expired, please sign in again')).toBeInTheDocument();
  });

  it('renders the platform navigation for an authenticated user', async () => {
    session.setAuth({ token: 'tok', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/me')
          ? jsonResponse(200, { data: { id: '1', name: 'Sadia Ahmed', email: 's@storeplix.com', phone: null, created_at: '' } })
          : jsonResponse(200, { data: { status: 'ok', version: '0.1.0', time: new Date().toISOString() } }),
      ),
    );
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Merchants' })).toHaveAttribute('href', '/merchants');
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });
});
