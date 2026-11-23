import type { AdminSession, AdminTenant, PlatformPermission, PlatformRole } from '@storeplix/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthProvider';
import { ToastProvider } from '../lib/toast';

export function renderApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <ToastProvider>{ui}</ToastProvider>
        </AuthProvider>
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

export const unauthenticated = () =>
  jsonResponse(401, {
    error: { code: 'unauthenticated', message: 'Unauthenticated.' },
  });

// §2.1 matrix (mirrors App\Domain\Admin\Authorization\PlatformRole).
export const grants: Record<PlatformRole, PlatformPermission[]> = {
  super_admin: ['view_merchants', 'impersonate', 'manage_billing', 'manage_domains', 'suspend', 'manage_team'],
  billing: ['view_merchants', 'manage_billing'],
  support: ['view_merchants', 'impersonate', 'manage_domains'],
  read_only: ['view_merchants'],
};

export function adminSession(role: PlatformRole = 'super_admin', extra: Partial<AdminSession['user']> = {}): AdminSession {
  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
  return {
    user: {
      id: 'U1',
      name: 'Sadia Ahmed',
      email: 'sadia@storeplix.com',
      platform_role: role,
      permissions: grants[role],
      totp_enrolled: true,
      recovery_codes_left: 10,
      ...extra,
    },
    session_expires_at: soon(12 * 3600_000),
    idle_expires_at: soon(30 * 60_000),
  };
}

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

/**
 * Stubs fetch with an ordered list of handlers (first non-undefined answer wins). `/admin/auth/me` answers the given
 * session (or 401 when `session` is null), `/health` and `/sanctum/csrf-cookie` always answer. Unknown → 404.
 */
export function mockApi(handlers: Handler[] = [], { session = adminSession() as AdminSession | null } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      credentials: init.credentials,
    };
    calls.push(call);
    for (const h of handlers) {
      const res = await h(call);
      if (res) return res;
    }
    if (url.pathname === '/sanctum/csrf-cookie') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/health'))
      return jsonResponse(200, {
        data: {
          status: 'ok',
          version: '0.1.0',
          time: new Date().toISOString(),
        },
      });
    if (url.pathname.endsWith('/admin/auth/me')) return session ? jsonResponse(200, { data: session }) : unauthenticated();
    if (url.pathname.endsWith('/plans')) return jsonResponse(200, { data: plans });
    return jsonResponse(404, {
      error: { code: 'not_found', message: 'Not found.' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const find = (method: string, path: string | RegExp) =>
    calls.filter((c) => c.method === method && (typeof path === 'string' ? c.url.pathname === `/api/v1${path}` : path.test(c.url.pathname)));
  return { calls, find, fetchMock };
}

/** Route helper: `on('GET', '/admin/overview', () => jsonResponse(...))`. */
export const on =
  (method: string, path: string | RegExp, respond: (call: Call) => Response): Handler =>
  (call) =>
    call.method === method && (typeof path === 'string' ? call.url.pathname === `/api/v1${path}` : path.test(call.url.pathname)) ? respond(call) : undefined;

const limits = {
  orders_per_month: 100,
  staff_seats: 1,
  products: 50,
  courier_connections: 1,
  sms_per_month: 0,
  custom_domains: 0,
};
export const plans = [
  {
    id: 'P0',
    code: 'free',
    name: 'Free',
    price_amount: 0,
    price_yearly_amount: null,
    currency: 'BDT',
    interval: 'month',
    limits,
    features: [],
  },
  {
    id: 'P1',
    code: 'starter',
    name: 'Starter',
    price_amount: 49900,
    price_yearly_amount: 499000,
    currency: 'BDT',
    interval: 'month',
    limits,
    features: [],
  },
  {
    id: 'P2',
    code: 'growth',
    name: 'Growth',
    price_amount: 119900,
    price_yearly_amount: 1199000,
    currency: 'BDT',
    interval: 'month',
    limits,
    features: [],
  },
];

export function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'SUB1',
    status: 'active',
    plan: plans[1],
    trial_ends_at: null,
    current_period_start: '2026-11-17T04:00:00Z',
    current_period_end: '2026-12-17T04:00:00Z',
    cancel_at_period_end: false,
    billing_interval: 'month',
    scheduled_change: null,
    past_due_at: null,
    grace_ends_at: null,
    domain_grace_ends_at: null,
    open_invoice: null,
    ...overrides,
  } as unknown as NonNullable<AdminTenant['subscription']>;
}

export function tenant(overrides: Partial<AdminTenant> = {}): AdminTenant {
  return {
    id: 'T1',
    name: 'Gadget Haat',
    status: 'active',
    store: {
      id: 'S1',
      name: 'Gadget Haat',
      slug: 'gadgethaat',
      status: 'active',
      primary_host: 'gadgethaat.storeplix.com',
    },
    owner: {
      id: 'O1',
      name: 'Tanvir Ahmed',
      email: 'tanvir@example.com',
      phone: '01912773401',
    },
    plan_code: 'starter',
    billing_interval: 'month',
    subscription_status: 'active',
    trial_ends_at: null,
    current_period_end: '2026-12-17T04:00:00Z',
    created_at: '2025-03-14T04:00:00Z',
    suspension: null,
    subscription: null,
    usage: [{ key: 'orders_per_month', used: 40, limit: 100 }],
    member_count: 2,
    domain_count: 1,
    lifetime_paid_amount: 359880,
    open_invoice: null,
    ...overrides,
  };
}

export const emptyList = (meta: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    data: [],
    meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, ...meta },
  });
export const cursorList = (data: unknown[] = []) =>
  jsonResponse(200, {
    data,
    meta: { next_cursor: null, prev_cursor: null, per_page: 50 },
  });
