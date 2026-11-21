import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import { session } from './lib/session';
import { jsonResponse, renderApp } from './test/utils';

describe('super-admin', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('renders the platform navigation for an authenticated user', async () => {
    session.setToken('tok');
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
