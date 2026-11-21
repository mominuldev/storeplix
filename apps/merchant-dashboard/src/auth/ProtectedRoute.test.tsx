import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from '../lib/session';
import { jsonResponse, renderApp } from '../test/utils';
import { ProtectedRoute } from './ProtectedRoute';

function routes() {
  return (
    <Routes>
      <Route path="/login" element={<p>Login screen</p>} />
      <Route element={<ProtectedRoute />}>
        <Route path="/orders" element={<p>Orders screen</p>} />
      </Route>
    </Routes>
  );
}

describe('ProtectedRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('redirects anonymous users to /login', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderApp(routes(), { route: '/orders' });
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the page once /auth/me succeeds', async () => {
    session.setToken('tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { id: '1', name: 'Rahim', email: 'r@x.co', phone: null, created_at: '', tenants: [] } })));
    renderApp(routes(), { route: '/orders' });
    expect(await screen.findByText('Orders screen')).toBeInTheDocument();
  });

  it('clears an invalid token and redirects to /login', async () => {
    session.setToken('expired');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } })));
    renderApp(routes(), { route: '/orders' });
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(session.getToken()).toBeNull();
  });
});
