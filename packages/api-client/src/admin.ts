// Phase 8.1 super admin (PHASE-8-1-CONTRACT §6; openapi 1.9.0 tag `admin`). Every /admin/* call is account-level: no
// X-Tenant-Id is ever sent (the admin API never reads it). Writes take a `reason` (5–500 chars, stored in the audit log).
import type {
  AcceptPlatformInvitationInput,
  AdminAuditEntry,
  AdminChangePlanInput,
  AdminDomain,
  AdminDomainState,
  AdminExtendInput,
  AdminInvoice,
  AdminInvoiceSummary,
  AdminLoginInput,
  AdminLoginStep,
  AdminMarkPaidInput,
  AdminOverview,
  AdminQuoteInput,
  AdminReactivateInput,
  AdminSearchResult,
  AdminSession,
  AdminSuspendInput,
  AdminTenant,
  AdminTenantCounts,
  AdminTenantMember,
  AdminTenantSummary,
  AdminTenantTab,
  AdminTotpInput,
  ApiSuccess,
  AuditActorType,
  BillingInvoiceStatus,
  BillingQuote,
  CreateImpersonationInput,
  CursorMeta,
  Impersonation,
  ImpersonationStatus,
  ImpersonationTicket,
  InvitePlatformStaffInput,
  PaginationMeta,
  PlatformInvitation,
  PlatformInvitationLookup,
  PlatformRole,
  PlatformStaff,
  PlatformTeamMeta,
  Subscription,
  TotpEnrollment,
  UpdatePlatformStaffInput,
} from '@storeplix/types';
import type { DownloadedFile, RequestOptions } from './client';

type Query = Record<string, string | number | undefined>;

/** The three transport primitives of `createApiClient` the admin namespace needs. */
export interface AdminTransport {
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  requestEnvelope<T>(path: string, opts?: RequestOptions): Promise<ApiSuccess<T> | undefined>;
  requestBlob(path: string, opts: Pick<RequestOptions, 'query' | 'signal'> & { fallbackName: string }): Promise<DownloadedFile>;
}

export interface AdminTenantFilters {
  status?: AdminTenantTab;
  plan?: string;
  q?: string;
  /** YYYY-MM-DD */
  created_from?: string;
  created_to?: string;
  sort?: '-created_at' | 'created_at' | 'name' | '-name' | 'current_period_end' | '-current_period_end';
  page?: number;
  per_page?: number;
}
export interface AdminTenantListMeta extends PaginationMeta { counts: AdminTenantCounts }

export interface AdminInvoiceFilters {
  status?: BillingInvoiceStatus;
  provider?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}

export interface AdminDomainFilters { state?: AdminDomainState; q?: string; page?: number; per_page?: number }

export interface AdminAuditFilters {
  tenant?: string;
  actor?: string;
  actor_type?: AuditActorType;
  /** Prefix, e.g. `billing.` */
  action?: string;
  from?: string;
  to?: string;
  impersonation?: boolean;
  cursor?: string;
  per_page?: number;
}

export interface AdminImpersonationFilters { status?: ImpersonationStatus; staff?: string; tenant?: string; page?: number; per_page?: number }

export interface AdminTeamFilters { status?: 'active' | 'invited' | 'disabled'; role?: PlatformRole; q?: string }

const enc = encodeURIComponent;
const blank = (v: string | undefined | null) => (v ? v : undefined);

/** `AdminTenantFilters` → `filter[...]` params. `status: 'all'` is the default and is not sent. */
export function adminTenantQuery(f: AdminTenantFilters = {}): Query {
  return {
    'filter[status]': f.status && f.status !== 'all' ? f.status : undefined,
    'filter[plan]': blank(f.plan),
    'filter[q]': blank(f.q?.trim()),
    'filter[created_from]': blank(f.created_from),
    'filter[created_to]': blank(f.created_to),
    sort: f.sort,
    page: f.page,
    per_page: f.per_page,
  };
}

export function adminInvoiceQuery(f: AdminInvoiceFilters = {}): Query {
  return {
    'filter[status]': f.status,
    'filter[provider]': blank(f.provider),
    'filter[q]': blank(f.q?.trim()),
    'filter[from]': blank(f.from),
    'filter[to]': blank(f.to),
    page: f.page,
    per_page: f.per_page,
  };
}

export function adminDomainQuery(f: AdminDomainFilters = {}): Query {
  return {
    'filter[state]': f.state && f.state !== 'all' ? f.state : undefined,
    'filter[q]': blank(f.q?.trim()),
    page: f.page,
    per_page: f.per_page,
  };
}

export function adminAuditQuery(f: AdminAuditFilters = {}): Query {
  return {
    'filter[tenant]': blank(f.tenant),
    'filter[actor]': blank(f.actor),
    'filter[actor_type]': f.actor_type,
    'filter[action]': blank(f.action),
    'filter[from]': blank(f.from),
    'filter[to]': blank(f.to),
    'filter[impersonation]': f.impersonation ? 1 : undefined,
    cursor: blank(f.cursor),
    per_page: f.per_page,
  };
}

export function adminImpersonationQuery(f: AdminImpersonationFilters = {}): Query {
  return {
    'filter[status]': f.status,
    'filter[staff]': blank(f.staff),
    'filter[tenant]': blank(f.tenant),
    page: f.page,
    per_page: f.per_page,
  };
}

export function adminTeamQuery(f: AdminTeamFilters = {}): Query {
  return { 'filter[status]': f.status, 'filter[role]': f.role, 'filter[q]': blank(f.q?.trim()) };
}

const emptyPage = (): PaginationMeta => ({ current_page: 1, per_page: 25, total: 0, last_page: 1 });
const emptyCursor = (): CursorMeta => ({ next_cursor: null, prev_cursor: null, per_page: 50 });

export function createAdminApi(t: AdminTransport) {
  const get = <T>(path: string, query?: Query) => t.request<T>(path, { query, noTenant: true });
  const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    t.request<T>(path, { method: 'POST', body, headers, noTenant: true });
  async function list<T, M>(path: string, query: Query, fallback: M): Promise<{ data: T[]; meta: M }> {
    const env = await t.requestEnvelope<T[]>(path, { query, noTenant: true });
    return { data: env?.data ?? [], meta: (env?.meta as M | undefined) ?? fallback };
  }
  const tenant = (id: string) => `/admin/tenants/${enc(id)}`;
  const invoice = (id: string) => `/admin/invoices/${enc(id)}`;
  const domain = (id: string) => `/admin/domains/${enc(id)}`;
  const member = (id: string) => `/admin/team/members/${enc(id)}`;

  return {
    /** §3.1 sign-in. Pre-auth routes need CSRF but no session; wrong credentials → the same 422 on `email`. */
    auth: {
      login: (input: AdminLoginInput) =>
        t.request<AdminLoginStep>('/admin/auth/login', { method: 'POST', body: { email: input.email, password: input.password }, anonymous: true }),
      /** Once per login token; 404 when the token is unknown, expired or already used. */
      enrollment: (loginToken: string) =>
        t.request<TotpEnrollment>('/admin/auth/enroll', { query: { login_token: loginToken }, anonymous: true }),
      /** Confirms the secret and signs in. `recovery_codes` (10) are shown once. */
      confirmEnrollment: async (loginToken: string, code: string): Promise<{ session: AdminSession; recovery_codes: string[] }> => {
        const env = await t.requestEnvelope<AdminSession>('/admin/auth/enroll', {
          method: 'POST',
          body: { login_token: loginToken, code },
          anonymous: true,
        });
        const meta = env?.meta as { recovery_codes?: string[] } | undefined;
        return { session: env!.data, recovery_codes: meta?.recovery_codes ?? [] };
      },
      /** 422 `invalid_totp` with `details.attempts_left`; the 5th failure drops the token (then 404). */
      totp: (input: AdminTotpInput) =>
        t.request<AdminSession>('/admin/auth/totp', {
          method: 'POST',
          body: 'code' in input ? { login_token: input.login_token, code: input.code } : { login_token: input.login_token, recovery_code: input.recovery_code },
          anonymous: true,
        }),
      /** Refreshes the idle timer. 401 when signed out or expired. */
      me: () => get<AdminSession>('/admin/auth/me'),
      logout: () => post<void>('/admin/auth/logout'),
    },

    invitations: {
      lookup: (token: string) => t.request<PlatformInvitationLookup>(`/admin/invitations/${enc(token)}`, { anonymous: true }),
      /** Always answers `step: enroll`. */
      accept: (token: string, input: AcceptPlatformInvitationInput) =>
        t.request<AdminLoginStep>(`/admin/invitations/${enc(token)}/accept`, {
          method: 'POST',
          body: { name: input.name, password: input.password, password_confirmation: input.password_confirmation },
          anonymous: true,
        }),
    },

    overview: () => get<AdminOverview>('/admin/overview'),
    /** `q` ≥ 2 chars; up to 5 tenants, 5 domains, 5 invoices. */
    search: (q: string, opts?: Pick<RequestOptions, 'signal'>) =>
      t.request<AdminSearchResult>('/admin/search', { query: { q: q.trim() }, noTenant: true, signal: opts?.signal }),

    tenants: {
      list: (filters: AdminTenantFilters = {}) =>
        list<AdminTenantSummary, AdminTenantListMeta>('/admin/tenants', adminTenantQuery(filters), {
          ...emptyPage(),
          counts: { all: 0, paying: 0, trial: 0, past_due: 0, suspended: 0 },
        }),
      get: (id: string) => get<AdminTenant>(tenant(id)),
      members: (id: string) => get<AdminTenantMember[]>(`${tenant(id)}/members`),
      domains: (id: string) => get<AdminDomain[]>(`${tenant(id)}/domains`),
      invoices: (id: string, filters: { status?: BillingInvoiceStatus; page?: number; per_page?: number } = {}) =>
        list<AdminInvoiceSummary, PaginationMeta>(
          `${tenant(id)}/invoices`,
          { 'filter[status]': filters.status, page: filters.page, per_page: filters.per_page },
          emptyPage(),
        ),
      auditLogs: (id: string, filters: Omit<AdminAuditFilters, 'tenant'> = {}) =>
        list<AdminAuditEntry, CursorMeta>(`${tenant(id)}/audit-logs`, adminAuditQuery(filters), emptyCursor()),
      /** 409 `invalid_state_transition` when already suspended. */
      suspend: (id: string, input: AdminSuspendInput) =>
        post<AdminTenant>(`${tenant(id)}/suspend`, { reason_code: input.reason_code, reason: input.reason, notify: input.notify }),
      reactivate: (id: string, input: AdminReactivateInput) =>
        post<AdminTenant>(`${tenant(id)}/reactivate`, { reason: input.reason, notify: input.notify }),
      /** No side effects. */
      quote: (id: string, input: AdminQuoteInput) =>
        post<BillingQuote>(`${tenant(id)}/billing/quote`, { plan_code: input.plan_code, interval: input.interval, effective: input.effective }),
      /** `idempotencyKey`: one per dialog open, reused on retry. 409 `plan_unchanged`, 422 `plan_unavailable`. */
      changePlan: (id: string, input: AdminChangePlanInput, idempotencyKey: string) =>
        post<Subscription>(
          `${tenant(id)}/billing/change-plan`,
          { plan_code: input.plan_code, interval: input.interval, effective: input.effective, reason: input.reason, notify: input.notify },
          { 'Idempotency-Key': idempotencyKey },
        ),
      extend: (id: string, input: AdminExtendInput) => post<Subscription>(`${tenant(id)}/subscription/extend`, { days: input.days, reason: input.reason }),
      /** 201; open `url` (merchant app, ticket in the fragment) in a new tab within 60 s. */
      impersonate: (id: string, input: CreateImpersonationInput) =>
        post<ImpersonationTicket>(`${tenant(id)}/impersonations`, { reason: input.reason, ticket_ref: input.ticket_ref || null }),
    },

    invoices: {
      list: (filters: AdminInvoiceFilters = {}) => list<AdminInvoiceSummary, PaginationMeta>('/admin/invoices', adminInvoiceQuery(filters), emptyPage()),
      get: (id: string) => get<AdminInvoice>(invoice(id)),
      pdf: (id: string, number?: string) => t.requestBlob(`${invoice(id)}/pdf`, { fallbackName: `${number ?? 'invoice'}.pdf` }),
      /** `Idempotency-Key` required. 409 `invoice_not_open`. */
      markPaid: (id: string, input: AdminMarkPaidInput, idempotencyKey: string) =>
        post<AdminInvoice>(`${invoice(id)}/mark-paid`, { reference: input.reference, reason: input.reason }, { 'Idempotency-Key': idempotencyKey }),
      void: (id: string, reason: string) => post<AdminInvoice>(`${invoice(id)}/void`, { reason }),
      /** 202, no body. Rate-limited 3/hour per invoice. */
      resend: (id: string) => post<void>(`${invoice(id)}/resend`),
    },

    domains: {
      list: (filters: AdminDomainFilters = {}) => list<AdminDomain, PaginationMeta>('/admin/domains', adminDomainQuery(filters), emptyPage()),
      /** 202 `AdminDomain`; 402 when the shop's plan has no custom domains. */
      recheck: (id: string) => post<AdminDomain>(`${domain(id)}/recheck`),
      suspend: (id: string, reason: string) => post<AdminDomain>(`${domain(id)}/suspend`, { reason }),
      reinstate: (id: string, reason: string) => post<AdminDomain>(`${domain(id)}/reinstate`, { reason }),
    },

    auditLogs: (filters: AdminAuditFilters = {}) => list<AdminAuditEntry, CursorMeta>('/admin/audit-logs', adminAuditQuery(filters), emptyCursor()),

    impersonations: {
      list: (filters: AdminImpersonationFilters = {}) =>
        list<Impersonation, PaginationMeta>('/admin/impersonations', adminImpersonationQuery(filters), emptyPage()),
      revoke: (id: string, reason: string) => post<Impersonation>(`/admin/impersonations/${enc(id)}/revoke`, { reason }),
    },

    team: {
      list: (filters: AdminTeamFilters = {}) =>
        list<PlatformStaff, PlatformTeamMeta | null>('/admin/team', adminTeamQuery(filters), null),
      invite: (input: InvitePlatformStaffInput) => post<PlatformInvitation>('/admin/team/invitations', { email: input.email, role: input.role }),
      revokeInvitation: (id: string) => t.request<void>(`/admin/team/invitations/${enc(id)}`, { method: 'DELETE', noTenant: true }),
      /** 409 `last_super_admin` | `staff_self_action`. */
      updateRole: (userId: string, input: UpdatePlatformStaffInput) =>
        t.request<PlatformStaff>(member(userId), { method: 'PATCH', body: { role: input.role, reason: input.reason }, noTenant: true }),
      disable: (userId: string, reason: string) => post<PlatformStaff>(`${member(userId)}/disable`, { reason }),
      enable: (userId: string, reason: string) => post<PlatformStaff>(`${member(userId)}/enable`, { reason }),
      resetTotp: (userId: string, reason: string) => post<PlatformStaff>(`${member(userId)}/reset-2fa`, { reason }),
    },
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;
