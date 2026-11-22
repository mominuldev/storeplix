import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { session } from '../lib/session';

export function renderApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export function jsonResponse(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (init: RequestInit, headers: Record<string, string>) => Response;

/** Stubs global fetch with handlers keyed by "METHOD /path" (path after /api/v1). Unknown routes → 404. `GET /auth/me` is 401 while signed out. */
export function mockApi(routes: Record<string, Handler | Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
    if (url.pathname === '/sanctum/csrf-cookie') return new Response(null, { status: 204 });
    // 4.7b: the HttpOnly session cookie is simulated by the session store's signed-in flag.
    if (key === 'GET /auth/me' && !session.isSignedIn()) return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Unauthenticated.' } });
    const route = routes[key];
    if (!route) return jsonResponse(404, { error: { code: 'not_found', message: `No mock for ${key}` } });
    return typeof route === 'function' ? route(init, (init.headers ?? {}) as Record<string, string>) : route.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const future = () => new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

export const tenantA = { id: 'T1', name: 'Mugdho Fashion', role: 'owner' as const };
export const tenantB = { id: 'T2', name: 'Deshi Organic', role: 'staff' as const };

export function user(tenants: { id: string; name: string; role: 'owner' | 'admin' | 'staff' }[] = [tenantA]) {
  return { id: 'U1', name: 'Rahim Ahmed', email: 'rahim@shop.com', phone: '8801712345678', phone_verified_at: '2026-11-01T00:00:00Z', password_changed_at: null, created_at: '', tenants };
}

export function store(overrides: Record<string, unknown> = {}) {
  return {
    id: 'S1',
    tenant_id: 'T1',
    name: 'Mugdho Fashion',
    slug: 'mugdho',
    status: 'draft',
    country: 'BD',
    currency: 'BDT',
    business_categories: ['fashion'],
    name_bn: null,
    timezone: 'Asia/Dhaka',
    primary_domain: 'mugdho.storeplix.com',
    created_at: '',
    ...overrides,
  };
}

export const okHealth = () => jsonResponse(200, { data: { status: 'ok', version: '1', time: new Date().toISOString() } });

export function settingsFixture(overrides: Record<string, unknown> = {}) {
  return {
    store_id: 'S1',
    identity: { name: 'Mugdho Fashion', name_bn: null, slug: 'mugdho', primary_domain: 'mugdho.storeplix.com', business_categories: ['fashion'] },
    branding: { logo: null, favicon: null, primary_color: '#5b53ff', secondary_color: '#fc856d' },
    contact: { phone: null, email: null, whatsapp: null, support_hours: null },
    social: { facebook: null, instagram: null, youtube: null },
    address: { street: null, division: null, district: null, area: null, postcode: null, use_for_returns: true },
    region: { country: 'BD', currency: 'BDT', timezone: 'Asia/Dhaka' },
    updated_at: '2026-11-21T00:00:00Z',
    ...overrides,
  };
}

export function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'M1',
    kind: 'member',
    user_id: 'U9',
    name: 'Nusrat Jahan',
    email: 'nusrat@shop.com',
    phone: null,
    role: 'staff',
    status: 'active',
    is_you: false,
    invited_by: null,
    joined_at: '2026-11-01T00:00:00Z',
    expires_at: null,
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

/** Signed-in merchant with one tenant + store; extra routes override/extend. */
export function signedIn(role: 'owner' | 'admin' | 'staff', routes: Record<string, Parameters<typeof mockApi>[0][string]> = {}) {
  session.start({ expires_at: future() });
  return mockApi({
    'GET /auth/me': jsonResponse(200, { data: user([{ ...tenantA, role }]) }),
    'GET /stores': jsonResponse(200, { data: [store()] }),
    'GET /health': okHealth(),
    'GET /stores/S1/settings': jsonResponse(200, { data: settingsFixture() }),
    ...routes,
  });
}

/** Calls made to an API path (after /api/v1), ignoring the 4.7b boot calls (/auth/me, /sanctum/csrf-cookie). */
export function callsTo(fetchMock: { mock: { calls: unknown[][] } }, path: string) {
  return fetchMock.mock.calls.filter((c) => new URL(String(c[0]), 'http://localhost').pathname === `/api/v1${path}`) as [string, RequestInit][];
}
