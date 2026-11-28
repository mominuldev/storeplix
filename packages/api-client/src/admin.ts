// Phase 8.1 super admin (PHASE-8-1-CONTRACT §6; openapi 1.9.0 tag `admin`; amendment A1 adds `settings`). Every /admin/* call is account-level: no
// X-Tenant-Id is ever sent (the admin API never reads it). Writes take a `reason` (5–500 chars, stored in the audit log).
import type {
  AdminApproveSenderIdInput,
  AdminRejectSenderIdInput,
  AdminSenderIdFilters,
  AdminSenderIdListMeta,
  AdminSenderIdRequest,
  AdminSmsCreditAdjustInput,
  AdminSmsCredits,
  SmsCreditLedgerEntry,
  SmsCreditLedgerFilters,
  AcceptPlatformInvitationInput,
  AdminAnalyticsOverview,
  AdminAuditEntry,
  AdminChangePlanInput,
  AdminDomain,
  AdminDomainState,
  AdminExtendInput,
  AdminInvoice,
  AdminInvoiceSummary,
  AdminLoginInput,
  AdminLoginResult,
  AdminLoginStep,
  AdminMarkPaidInput,
  AdminOverview,
  AdminQuoteInput,
  AdminReactivateInput,
  AdminRevenueReport,
  AdminSearchResult,
  AdminSession,
  AdminSuspendInput,
  AdminTenant,
  AdminTenantCounts,
  AdminTenantMember,
  AdminTenantMetrics,
  AdminTenantSort,
  AdminTenantSummary,
  AdminTenantTab,
  AdminTotpInput,
  AnalyticsMeta,
  AnalyticsQuery,
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
  PlatformSecuritySettings,
  PlatformStaff,
  PlatformTeamMeta,
  Subscription,
  TotpEnrollment,
  UpdatePlatformSecuritySettingsInput,
  UpdatePlatformStaffInput,
  ActivateSmsProviderInput,
  CreateSmsProviderInput,
  PlatformSmsAlert,
  PlatformSmsAudienceCounts,
  PlatformSmsBroadcast,
  PlatformSmsBroadcastEstimate,
  PlatformSmsBroadcastEstimateInput,
  PlatformSmsBroadcastFilters,
  PlatformSmsBroadcastInput,
  PlatformSmsBroadcastListMeta,
  PlatformSmsBroadcastRecipient,
  PlatformSmsBroadcastTestInput,
  PlatformSmsLogEntry,
  PlatformSmsLogFilters,
  PlatformSmsMessageType,
  PlatformSmsMessageTypesMeta,
  PlatformSmsPreview,
  PlatformSmsPreviewInput,
  PlatformSmsTemplate,
  PlatformSmsTestInput,
  PlatformSmsTestResult,
  PlatformSmsType,
  RemoveSmsProviderInput,
  RotateSmsProviderCredentialsInput,
  SchedulePlatformSmsBroadcastInput,
  SmsProvider,
  SmsProviderDriverInfo,
  SmsProviderOverview,
  SmsProviderTestInput,
  SmsProviderTestResult,
  UpdatePlatformSmsBroadcastInput,
  UpdatePlatformSmsMessageTypeInput,
  UpdatePlatformSmsTemplateInput,
  UpdateSmsProviderInput,
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
  /** Phase 8.2 adds the metric sorts (`-mrr`, `-gmv_30d`, `-orders_30d`, `±last_active_at`; nulls last). */
  sort?: AdminTenantSort;
  page?: number;
  per_page?: number;
}
export interface AdminTenantListMeta extends PaginationMeta {
  counts: AdminTenantCounts;
  /** Phase 8.2: latest computed analytics day (null before the first nightly run). */
  metrics_as_of?: string | null;
}

/** Phase 8.2 analytics responses keep `meta` (as_of, computed_at, data_starts_on, resolved range). */
export interface AnalyticsResult<T> { data: T; meta: AnalyticsMeta }

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

/** PHASE-8-2 §6: `from`/`to` are only sent for `range=custom`; `granularity` only when set. */
export function analyticsQuery(q: AnalyticsQuery = {}): Query {
  const custom = q.range === 'custom';
  return {
    range: q.range,
    from: custom ? blank(q.from) : undefined,
    to: custom ? blank(q.to) : undefined,
    granularity: q.granularity,
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

/** PHASE-8-9A §10.3 sender-ID queue (default status `pending`). */
export function adminSenderIdQuery(f: AdminSenderIdFilters = {}): Query {
  return { 'filter[status]': f.status, 'filter[q]': blank(f.q?.trim()), page: f.page, per_page: f.per_page };
}

/** PHASE-8-9B §8 platform SMS log (comma lists; `q` = exact phone or shop name ≥ 2; dates Asia/Dhaka, ≤ 90 days back). */
export function platformSmsLogQuery(f: PlatformSmsLogFilters = {}): Query {
  return {
    'filter[q]': blank(f.q?.trim()),
    'filter[status]': f.status?.length ? f.status.join(',') : undefined,
    'filter[group]': f.group?.length ? f.group.join(',') : undefined,
    'filter[from]': blank(f.from),
    'filter[to]': blank(f.to),
    cursor: blank(f.cursor),
  };
}

/** PHASE-8-9B §7 past broadcasts (`filter[status]` comma list; Figma chips All / Scheduled / Sent / Drafts). */
export function platformSmsBroadcastQuery(f: PlatformSmsBroadcastFilters = {}): Query {
  return { 'filter[status]': f.status?.length ? f.status.join(',') : undefined, page: f.page, per_page: f.per_page };
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
  async function analytics<T>(path: string, query?: Query): Promise<AnalyticsResult<T>> {
    const env = await t.requestEnvelope<T>(path, { query, noTenant: true });
    return { data: env!.data, meta: env!.meta as unknown as AnalyticsMeta };
  }
  const tenant = (id: string) => `/admin/tenants/${enc(id)}`;
  const invoice = (id: string) => `/admin/invoices/${enc(id)}`;
  const domain = (id: string) => `/admin/domains/${enc(id)}`;
  const member = (id: string) => `/admin/team/members/${enc(id)}`;

  return {
    /** §3.1 sign-in. Pre-auth routes need CSRF but no session; wrong credentials → the same 422 on `email`. */
    auth: {
      /**
       * Amendment A1: `step: 'signed_in'` (setting off) carries the `AdminSession` and the session cookie is set;
       * `totp` / `enroll` carry a `login_token` for the second step.
       */
      login: (input: AdminLoginInput) =>
        t.request<AdminLoginResult>('/admin/auth/login', { method: 'POST', body: { email: input.email, password: input.password }, anonymous: true }),
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
    /** Phase 8.2 (`view_analytics`): dashboard KPIs, MRR by plan and plan mix. Default range `30d`. */
    analyticsOverview: (q: AnalyticsQuery = {}) => analytics<AdminAnalyticsOverview>('/admin/analytics/overview', analyticsQuery(q)),
    /** Phase 8.2 (`view_analytics`): revenue report. Default range `12m`. */
    revenueReport: (q: AnalyticsQuery = {}) => analytics<AdminRevenueReport>('/admin/analytics/revenue', analyticsQuery(q)),
    /** Phase 8.2 (`view_merchants`): one shop's 30-day metrics and 12 monthly GMV bars. 404 for an unknown tenant. */
    tenantMetrics: (id: string) => analytics<AdminTenantMetrics>(`/admin/tenants/${enc(id)}/metrics`),
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

    /**
     * PHASE-8-9A §10.3 sender-ID review (`manage_domains`: super_admin, support; P89A-14). Writes take a `reason` (5–500); a
     * rejection or revocation reason is shown to the merchant. Each is audited `sender_id.*` with
     * `// cross-tenant` access in the API.
     */
    senderIds: {
      list: (filters: AdminSenderIdFilters = {}) =>
        list<AdminSenderIdRequest, AdminSenderIdListMeta>('/admin/sender-ids', adminSenderIdQuery(filters), { ...emptyPage(), counts: { pending: 0 } }),
      get: (id: string) => get<AdminSenderIdRequest>(`/admin/sender-ids/${enc(id)}`),
      /** The trade licence (attachment); audited `sender_id.document_viewed`. */
      document: (id: string, filename?: string) => t.requestBlob(`/admin/sender-ids/${enc(id)}/document`, { fallbackName: filename ?? 'trade-licence' }),
      /** pending → approved (the shop's previous approved ID → superseded). 409 `invalid_state_transition`, `sender_id_taken`. */
      approve: (id: string, input: AdminApproveSenderIdInput) =>
        post<AdminSenderIdRequest>(`/admin/sender-ids/${enc(id)}/approve`, { provider_registered: input.provider_registered, reason: input.reason }),
      /** pending → rejected. */
      reject: (id: string, input: AdminRejectSenderIdInput) => post<AdminSenderIdRequest>(`/admin/sender-ids/${enc(id)}/reject`, { reason: input.reason }),
      /** approved → revoked (the shop falls back to the shared sender). */
      revoke: (id: string, reason: string) => post<AdminSenderIdRequest>(`/admin/sender-ids/${enc(id)}/revoke`, { reason }),
    },

    /** PHASE-8-9A §10.3 merchant SMS credits (read `view_merchants`; adjust `manage_billing`). */
    smsCredits: {
      get: (tenantId: string) => get<AdminSmsCredits>(`${tenant(tenantId)}/sms-credits`),
      ledger: (tenantId: string, filters: SmsCreditLedgerFilters = {}) =>
        list<SmsCreditLedgerEntry, CursorMeta>(
          `${tenant(tenantId)}/sms-credits/ledger`,
          { 'filter[type]': filters.type?.length ? filters.type.join(',') : undefined, cursor: filters.cursor || undefined },
          emptyCursor(),
        ),
      /** Grant (+) or deduct (−). `idempotencyKey` once per dialog open. 422 `sms_credits_insufficient`. */
      adjust: (tenantId: string, input: AdminSmsCreditAdjustInput, idempotencyKey: string) =>
        post<AdminSmsCredits>(`${tenant(tenantId)}/sms-credits/adjust`, { credits: input.credits, reason: input.reason }, { 'Idempotency-Key': idempotencyKey }),
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

    /** Amendment A1-4 (`manage_settings`, super_admin only). */
    settings: {
      getSecurity: () => get<PlatformSecuritySettings>('/admin/settings/security'),
      /** 422 `invalid_password` (on `current_password`) when the password is wrong. Audited `admin.settings_updated`. */
      updateSecurity: (input: UpdatePlatformSecuritySettingsInput) =>
        t.request<PlatformSecuritySettings>('/admin/settings/security', {
          method: 'PATCH',
          body: { staff_two_factor_required: input.staff_two_factor_required, current_password: input.current_password },
          noTenant: true,
        }),
    },

    /**
     * PHASE-8-9B platform SMS (`/settings/sms`). Every call needs platform permission `manage_settings` (super_admin
     * only, P89B-25). Secrets are write-only: providers come back with `credentials_hint` (last 4) only.
     */
    platformSms: {
      /** §4.1 driver catalogue (config; SSL Wireless, Alpha SMS and BulkSMSBD are `coming_soon`). */
      drivers: () => get<SmsProviderDriverInfo[]>('/admin/sms/drivers'),
      /** Shell banner (Figma 2111:9331 red banner, low balance, failover active). Cheap; poll on navigation. */
      alerts: () => get<PlatformSmsAlert[]>('/admin/sms/alerts'),
      providers: {
        /** §4.2 primary, failover, drafts/inactive, environment fallback, waiting, recent errors, alerts. */
        overview: () => get<SmsProviderOverview>('/admin/sms/providers'),
        get: (id: string) => get<SmsProvider>(`/admin/sms/providers/${enc(id)}`),
        /** 201 draft. 422 `sms_provider_driver_unavailable` (coming soon), 409 `sms_provider_name_taken`. */
        create: (input: CreateSmsProviderInput) => post<SmsProvider>('/admin/sms/providers', input),
        /** 409 `revision_conflict`. Connection fields of an active provider change only through `rotate`. */
        update: (id: string, input: UpdateSmsProviderInput) =>
          t.request<SmsProvider>(`/admin/sms/providers/${enc(id)}`, { method: 'PATCH', body: input, noTenant: true }),
        /** Synchronous test send with the stored credentials (10/hour per staff member). A failed test is 200 with `status: 'failed'`. */
        test: (id: string, input: SmsProviderTestInput) => post<SmsProviderTestResult>(`/admin/sms/providers/${enc(id)}/test`, { phone: input.phone }),
        /** 409 `sms_provider_test_required`, 422 `confirmation_mismatch` (primary needs the typed name). */
        activate: (id: string, input: ActivateSmsProviderInput) =>
          post<SmsProviderOverview>(`/admin/sms/providers/${enc(id)}/activate`, {
            role: input.role,
            confirm_name: input.confirm_name ?? null,
            keep_previous_as_failover: input.keep_previous_as_failover ?? true,
          }),
        /** Test with the new credentials, then swap; 422 `sms_provider_test_failed` keeps the old ones (P89B-5). */
        rotate: (id: string, input: RotateSmsProviderCredentialsInput) =>
          post<SmsProvider>(`/admin/sms/providers/${enc(id)}/rotate`, { credentials: input.credentials, settings: input.settings ?? null, phone: input.phone }),
        /** 409 `sms_provider_is_primary`; 422 `confirmation_mismatch`. Credentials are deleted, history kept. */
        remove: (id: string, input: RemoveSmsProviderInput) =>
          post<SmsProviderOverview>(`/admin/sms/providers/${enc(id)}/remove`, { confirm_name: input.confirm_name }),
        /** Reads the gateway balance now (6/hour per provider). */
        refreshBalance: (id: string) => post<SmsProvider>(`/admin/sms/providers/${enc(id)}/refresh-balance`),
      },
      messageTypes: {
        /** §6 nine types with bn/en templates; `meta.kpis` + `meta.groups`. */
        list: async (): Promise<{ data: PlatformSmsMessageType[]; meta: PlatformSmsMessageTypesMeta }> =>
          list<PlatformSmsMessageType, PlatformSmsMessageTypesMeta>('/admin/sms/message-types', {}, {
            kpis: { sent_this_month: 0, codes_this_month: 0, promotional_this_month: 0, cost_this_month_paisa: 0 },
            groups: [],
          }),
        /** On/off. 422 `platform_sms_type_locked`; 409 `broadcasts_pending` (broadcast off while one is scheduled/sending). */
        update: (type: PlatformSmsType, input: UpdatePlatformSmsMessageTypeInput) =>
          t.request<PlatformSmsMessageType>(`/admin/sms/message-types/${enc(type)}`, { method: 'PATCH', body: { enabled: input.enabled }, noTenant: true }),
        /** 422 `platform_sms_template_*` / `platform_sms_type_locked`, 409 `revision_conflict`. Body equal to the default resets. */
        updateTemplate: (type: PlatformSmsType, language: 'bn' | 'en', input: UpdatePlatformSmsTemplateInput) =>
          t.request<PlatformSmsTemplate>(`/admin/sms/message-types/${enc(type)}/templates/${enc(language)}`, {
            method: 'PUT',
            body: { body: input.body, revision: input.revision },
            noTenant: true,
          }),
        resetTemplate: (type: PlatformSmsType, language: 'bn' | 'en') =>
          t.request<PlatformSmsTemplate>(`/admin/sms/message-types/${enc(type)}/templates/${enc(language)}`, { method: 'DELETE', noTenant: true }),
        /** Same 422s as updateTemplate; nothing saved (60/min). */
        preview: (input: PlatformSmsPreviewInput, opts?: Pick<RequestOptions, 'signal'>) =>
          t.request<PlatformSmsPreview>('/admin/sms/message-types/preview', { method: 'POST', body: input, noTenant: true, signal: opts?.signal }),
        /** "Send test to me" (10/hour per staff member). */
        test: (type: PlatformSmsType, input: PlatformSmsTestInput) =>
          post<PlatformSmsTestResult>(`/admin/sms/message-types/${enc(type)}/test`, { language: input.language, phone: input.phone, body: input.body ?? null }),
      },
      broadcasts: {
        list: (filters: PlatformSmsBroadcastFilters = {}) =>
          list<PlatformSmsBroadcast, PlatformSmsBroadcastListMeta>('/admin/sms/broadcasts', platformSmsBroadcastQuery(filters), {
            ...emptyPage(),
            kpis: { broadcasts_this_month: 0, sent_success_rate: null, opted_out_total: 0, spend_this_month_paisa: 0 },
          }),
        /** Sub-chip counts for the audience cards. */
        audiences: () => get<PlatformSmsAudienceCounts>('/admin/sms/broadcasts/audiences'),
        /** No side effects. */
        estimate: (input: PlatformSmsBroadcastEstimateInput, opts?: Pick<RequestOptions, 'signal'>) =>
          t.request<PlatformSmsBroadcastEstimate>('/admin/sms/broadcasts/estimate', { method: 'POST', body: input, noTenant: true, signal: opts?.signal }),
        /** "Send test to me" with a test opt-out code (10/hour). */
        test: (input: PlatformSmsBroadcastTestInput) => post<PlatformSmsTestResult>('/admin/sms/broadcasts/test', input),
        /** 201 draft. */
        create: (input: PlatformSmsBroadcastInput) => post<PlatformSmsBroadcast>('/admin/sms/broadcasts', input),
        get: (id: string) => get<PlatformSmsBroadcast>(`/admin/sms/broadcasts/${enc(id)}`),
        /** Drafts only (409 `invalid_state_transition`), 409 `revision_conflict`. */
        update: (id: string, input: UpdatePlatformSmsBroadcastInput) =>
          t.request<PlatformSmsBroadcast>(`/admin/sms/broadcasts/${enc(id)}`, { method: 'PATCH', body: input, noTenant: true }),
        /** Drafts only. */
        delete: (id: string) => t.request<void>(`/admin/sms/broadcasts/${enc(id)}`, { method: 'DELETE', noTenant: true }),
        /**
         * Typed confirmation → scheduled (or sending when `scheduled_at` is null). 409 `broadcast_estimate_changed`
         * (details = fresh estimate), `promotional_sender_not_approved`, `revision_conflict`; 422 `outside_sending_hours`,
         * `gateway_balance_insufficient`, `broadcast_empty_audience`.
         */
        schedule: (id: string, input: SchedulePlatformSmsBroadcastInput) =>
          post<PlatformSmsBroadcast>(`/admin/sms/broadcasts/${enc(id)}/schedule`, {
            acknowledged: input.acknowledged,
            confirm_recipients: input.confirm_recipients,
            revision: input.revision,
          }),
        /** scheduled → cancelled (until it starts sending). */
        cancel: (id: string) => post<PlatformSmsBroadcast>(`/admin/sms/broadcasts/${enc(id)}/cancel`),
        recipients: (id: string, filters: { status?: string[]; cursor?: string } = {}) =>
          list<PlatformSmsBroadcastRecipient, CursorMeta>(
            `/admin/sms/broadcasts/${enc(id)}/recipients`,
            { 'filter[status]': filters.status?.length ? filters.status.join(',') : undefined, cursor: blank(filters.cursor) },
            emptyCursor(),
          ),
      },
      /** §8 platform-sent SMS only, 90 days, masked, codes hidden; cursor 50. */
      messages: (filters: PlatformSmsLogFilters = {}) =>
        list<PlatformSmsLogEntry, CursorMeta>('/admin/sms/messages', platformSmsLogQuery(filters), emptyCursor()),
      /** CSV (masked, codes hidden), same filters; 5/hour; audited `platform_sms.log_exported`. */
      exportMessages: (filters: Omit<PlatformSmsLogFilters, 'cursor'> = {}) =>
        t.requestBlob('/admin/sms/messages/export', { query: platformSmsLogQuery(filters), fallbackName: 'platform-sms-log.csv' }),
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
