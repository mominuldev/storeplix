import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App';
import { session } from './lib/session';
import { future, jsonResponse, mockApi, renderApp, store, tenantA, tenantB, user } from './test/utils';

const EXPIRED = 'Your session expired, please sign in again';

async function signIn() {
  await userEvent.type(await screen.findByLabelText('Email'), 'rahim@shop.com');
  await userEvent.type(screen.getByLabelText('Password'), 'password');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

const login = jsonResponse(200, { data: { token: 'tok', user: user(), expires_at: future() } });

describe('post-login routing (contract D1: one store per tenant)', () => {
  it('sends a merchant whose tenant has no store to "Name your shop"', async () => {
    mockApi({ 'POST /auth/login': login, 'GET /auth/me': jsonResponse(200, { data: user() }), 'GET /stores': jsonResponse(200, { data: [] }) });
    renderApp(<AppRoutes />, { route: '/login' });
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Name your shop' })).toBeInTheDocument();
    expect(sessionStorage.getItem('storeplix.merchant.token')).toBe('tok');
    expect(localStorage.getItem('storeplix.merchant.token')).toBeNull();
  });

  it('opens the dashboard when the tenant has its store', async () => {
    const api = mockApi({
      'POST /auth/login': login,
      'GET /auth/me': jsonResponse(200, { data: user() }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': jsonResponse(200, { data: { status: 'ok', version: '1', time: new Date().toISOString() } }),
    });
    renderApp(<AppRoutes />, { route: '/login' });
    await signIn();
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
    const storesCall = api.mock.calls.find(([url]) => String(url).includes('/stores'))!;
    expect((storesCall[1]!.headers as Record<string, string>)['X-Tenant-Id']).toBe('T1');
  });

  it('asks a user with several memberships to choose a shop, then opens the chosen tenant', async () => {
    mockApi({
      'POST /auth/login': login,
      'GET /auth/me': jsonResponse(200, { data: user([tenantA, tenantB]) }),
      'GET /stores': (_init, headers) =>
        jsonResponse(200, { data: [store(headers['X-Tenant-Id'] === 'T2' ? { id: 'S2', tenant_id: 'T2', name: 'Deshi Organic', slug: 'deshi', primary_domain: null } : {})] }),
      'GET /health': jsonResponse(200, { data: { status: 'ok', version: '1', time: new Date().toISOString() } }),
    });
    renderApp(<AppRoutes />, { route: '/login' });
    await signIn();
    expect(await screen.findByText('You have access to 2 shops.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Deshi Organic.*deshi\.storeplix\.com/ }));
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
    expect(session.getTenantId()).toBe('T2');
  });

  it('routes to the dashboard when POST /stores reports store_limit_reached', async () => {
    session.setAuth({ token: 'tok', expires_at: future() });
    let created = false;
    mockApi({
      'GET /auth/me': jsonResponse(200, { data: user() }),
      'GET /stores': () => jsonResponse(200, { data: created ? [store()] : [] }),
      'POST /stores': () => {
        created = true;
        return jsonResponse(409, { error: { code: 'store_limit_reached', message: 'This workspace already has a store.' } });
      },
      'GET /health': jsonResponse(200, { data: { status: 'ok', version: '1', time: new Date().toISOString() } }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    await userEvent.type(await screen.findByLabelText('Shop name'), 'Mugdho Fashion');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
  });
});

describe('token expiry (contract D3)', () => {
  it('redirects anonymous users to /login without a notice', async () => {
    const api = mockApi({});
    renderApp(<AppRoutes />, { route: '/orders' });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it('clears the session on 401 and shows the expiry message', async () => {
    session.setAuth({ token: 'revoked', expires_at: future() });
    mockApi({ 'GET /auth/me': jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } }) });
    renderApp(<AppRoutes />, { route: '/orders' });
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(session.getToken()).toBeNull();
  });

  it('logs out proactively when expires_at passes', async () => {
    session.setAuth({ token: 'tok', expires_at: new Date(Date.now() + 400).toISOString() });
    mockApi({
      'GET /auth/me': jsonResponse(200, { data: user() }),
      'GET /stores': jsonResponse(200, { data: [store()] }),
      'GET /health': jsonResponse(200, { data: { status: 'ok', version: '1', time: new Date().toISOString() } }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('heading', { name: /, Rahim$/ })).toBeInTheDocument();
    expect(await screen.findByText(EXPIRED, {}, { timeout: 2000 })).toBeInTheDocument();
    await waitFor(() => expect(session.getToken()).toBeNull());
  });

  it('expires a stored token whose expires_at is already in the past', async () => {
    session.setAuth({ token: 'old', expires_at: new Date(Date.now() - 1000).toISOString() });
    mockApi({ 'GET /auth/me': jsonResponse(200, { data: user() }) });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  });
});
