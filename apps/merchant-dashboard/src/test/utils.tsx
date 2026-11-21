import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';

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

/** Stubs global fetch with handlers keyed by "METHOD /path" (path after /api/v1). Unknown routes → 404. */
export function mockApi(routes: Record<string, Handler | Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/api/v1', '')}`;
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
  return { id: 'U1', name: 'Rahim Ahmed', email: 'rahim@shop.com', phone: null, created_at: '', tenants };
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
    business_category: 'Fashion',
    primary_domain: 'mugdho.storeplix.com',
    created_at: '',
    ...overrides,
  };
}
