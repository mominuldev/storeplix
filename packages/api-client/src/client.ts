import type {
  AcceptInvitationInput,
  CreateRoleInput,
  PermissionGroup,
  Role,
  RoleDetail,
  RolesMeta,
  UpdateRoleInput,
  ApiSuccess,
  AuditLog,
  AuditLogFilters,
  AuthSession as AuthSessionResponse,
  Category,
  ChangePasswordInput,
  CreateCategoryInput,
  CreateCustomerInput,
  CreateExportInput,
  CreateProductInput,
  Customer,
  CustomerDetail,
  CustomerListFilters,
  CustomerListMeta,
  CustomerNote,
  DashboardSummary,
  DataExport,
  DataImport,
  DataImportRow,
  DataImportType,
  InventoryItem,
  InventoryListFilters,
  InventoryListMeta,
  Product,
  ProductBulkInput,
  ProductBulkResult,
  ProductListFilters,
  ProductListMeta,
  ProductSummary,
  ReorderCategoriesInput,
  RunImportInput,
  StockAdjustmentInput,
  StockAdjustmentResult,
  StockMovement,
  StockMovementFilters,
  UpdateCategoryInput,
  UpdateCustomerInput,
  UpdateProductInput,
  ValidateImportInput,
  CreatePageInput,
  CreateStoreInput,
  FeatureAccess,
  ForgotPasswordInput,
  HealthStatus,
  InvitationPreview,
  InviteStaffInput,
  LoginInput,
  MeMeta,
  Media,
  MediaListFilters,
  MediaPurpose,
  NavigationHandle,
  NavigationMenu,
  PageListMeta,
  PageStatus,
  PageTemplate,
  PublishThemeInput,
  SaveNavigationInput,
  SaveThemeDraftInput,
  StorePage,
  StorePageSummary,
  StoreTheme,
  StoreThemeSummary,
  ThemeCatalogEntry,
  UpdatePageInput,
  MessageResponse,
  OtpLoginInput,
  OtpResetPasswordInput,
  SendOtpInput,
  SendOtpResponse,
  User,
  VerifyPhoneInput,
  PaginationMeta,
  Plan,
  PreviewToken,
  RegisterInput,
  ResetPasswordInput,
  StaffMember,
  StaffSeatsMeta,
  Store,
  StorefrontConfigResponse,
  StoreSettings,
  Subscription,
  TenantMembership,
  UpdateProfileInput,
  UpdateStaffRoleInput,
  UpdateStoreSettingsInput,
  BdGeo,
  CancelOrderInput,
  Coupon,
  CouponListFilters,
  CouponListMeta,
  CreateCouponInput,
  LaunchChecklist,
  ManualOrderInput,
  Order,
  OrderBulkInput,
  OrderBulkResult,
  OrderEvent,
  OrderListFilters,
  OrderListMeta,
  OrderQuote,
  OrderSummary,
  Payment,
  PickupLocation,
  PickupLocationInput,
  RefundInput,
  ReturnOrderInput,
  SaveShippingInput,
  ShipOrderInput,
  ShippingQuote,
  ShippingSettings,
  UpdateCouponInput,
  UpdateOrderInput,
  CreateDocumentInput,
  CreateReturnInput,
  DocumentKind,
  DocumentTemplate,
  DocumentTemplateConfig,
  EditOrderItemsInput,
  ExchangeOrderInput,
  OrderItemsQuote,
  PaymentLink,
  ConnectGatewayInput,
  CreatePaymentLinkInput,
  GatewayProvider,
  GatewayTestPayment,
  PaymentGatewayAccount,
  UpdateGatewayInput,
  ConnectCourierInput,
  CourierAccount,
  CourierArea,
  CourierProvider,
  UpdateCourierInput,
  ReceiveReturnInput,
  RestockInput,
  ReturnEvent,
  ReturnListMeta,
  BillingInvoice,
  BillingInvoiceListMeta,
  BillingInvoiceStatus,
  BillingInvoiceSummary,
  BillingPayment,
  BillingQuote,
  BillingQuoteInput,
  ChangePlanResult,
  DeliveryReport,
  PayInvoiceInput,
  ProfitReport,
  ReportMeta,
  ReportRangeQuery,
  SalesReport,
  ReturnRequest,
  ReturnSummary,
  StoreDocument,
  BookShipmentInput,
  Shipment,
  ShipmentBatch,
  ShipmentDetail,
  ShipmentListFilters,
  ShipmentListMeta,
  ShipmentSummary,
  AddDomainInput,
  DomainListMeta,
  StoreDomain,
  ApiKey,
  ApiKeyCreated,
  ApiScopeInfo,
  CreateApiKeyInput,
  CreateWebhookEndpointInput,
  CursorMeta,
  UpdateApiKeyInput,
  UpdateWebhookEndpointInput,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryFilters,
  WebhookEndpoint,
  WebhookEventTypeInfo,
  WebhookResendFailedResult,
  WebhookSecret,
  WebhookSecretRevealed,
  AudiencePreview,
  AudiencePreviewInput,
  Campaign,
  CampaignEstimate,
  CampaignEstimateInput,
  CampaignListFilters,
  CampaignListItem,
  CampaignRecipient,
  CampaignRecipientFilters,
  CampaignTestResult,
  CreateCampaignInput,
  CustomerMarketing,
  DevSinkMessage,
  MarketingChannel,
  MarketingOverview,
  MarketingRange,
  ScheduleCampaignInput,
  UnsubscribeInput,
  UnsubscribeStatus,
  UpdateCampaignInput,
  Automation,
  AutomationDetail,
  AutomationDryRun,
  AutomationDryRunInput,
  AutomationListMeta,
  AutomationRun,
  AutomationRunFilters,
  AutomationStats,
  AutomationStatsDays,
  AutomationTestResult,
  CartContactInput,
  CreateAutomationInput,
  RecipeKey,
  RecoverCartResult,
  UpdateAutomationInput,
} from '@storeplix/types';
import { createAdminApi } from './admin';
import { createImpersonationAuth } from './impersonation';
import { ApiError, isErrorEnvelope } from './errors';
import type { CourierAreaList, CourierAreaQuery, CourierConnectResult, CourierPickupStore, CourierTestResult, CourierWebhookSecret, MeResponse } from './models';
import { couponListQuery, customerListQuery, filenameFromDisposition, inventoryListQuery, movementListQuery, orderListQuery, productListQuery, returnListQuery, shipmentListQuery, type ReturnListFilters } from './queries';

export interface ApiClientOptions {
  /**
   * API origin. `''` (the SPAs, Phase 4.7) = same-origin relative URLs through the Vite/Nginx proxy;
   * `http://localhost:8010` for server-to-server use. `/api/v1` is appended automatically.
   */
  baseUrl: string;
  /** fetch credentials mode. Default `same-origin` (session cookie, contract §7.3). */
  credentials?: RequestCredentials;
  /**
   * Sanctum CSRF (contract §7.3): fetch `/sanctum/csrf-cookie` when needed, send `X-XSRF-TOKEN` on writes, retry a
   * 419 once. Default: on in browsers (when `document` exists), off elsewhere.
   */
  csrf?: boolean;
  /** Cookie reader (tests). Defaults to `document.cookie`. */
  readCookies?: () => string;
  /** Returns the active tenant ULID, sent as `X-Tenant-Id`. */
  getTenantId?: () => string | null | undefined;
  /** Custom fetch (tests, Next.js `fetch` with cache options). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** XMLHttpRequest factory for uploads with progress. Defaults to the global constructor when present. */
  xhr?: () => XMLHttpRequest;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Called on any 401 (e.g. to clear the session). */
  onUnauthorized?: (error: ApiError) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip X-Tenant-Id (public or server-to-server endpoints). */
  anonymous?: boolean;
  /** No X-Tenant-Id (account-level endpoints, invitation accept). */
  noTenant?: boolean;
  /** Override the X-Tenant-Id for this call (e.g. listing each membership's store). */
  tenantId?: string;
  /** Passed through to fetch (Next.js uses `next`/`cache`). */
  init?: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } };
}

export interface Paginated<T> {
  data: T;
  meta?: PaginationMeta | Record<string, unknown>;
}

export interface UploadMediaInput {
  file: Blob;
  purpose: MediaPurpose;
  alt?: string;
  /** File name sent in the multipart body (defaults to `File.name` or "upload"). */
  filename?: string;
}

/** A downloaded file (CSV template, error report). */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

export interface UploadOptions {
  /** 0..1 fraction of bytes sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const API_PREFIX = '/api/v1';
const enc = encodeURIComponent;

/** Parses a raw response into the envelope or throws ApiError. Shared by fetch and XHR paths. */
function parseResponse<T>(status: number, statusText: string, text: string): ApiSuccess<T> | undefined {
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (status < 200 || status >= 300) {
    throw isErrorEnvelope(body)
      ? new ApiError(status, body.error.code, body.error.message, body.error.details, retryAfterOf(body))
      : new ApiError(status, status === 413 ? 'payload_too_large' : 'http_error', status === 413 ? 'This file is too large.' : statusText || `Request failed (${status})`);
  }
  if (status === 204 || !text) return undefined;
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new ApiError(status, 'invalid_response', 'Unexpected response from the server.');
  }
  return body as ApiSuccess<T>;
}

/** `retry_after` may arrive at the error root or inside `details` (as a number or a one-item array). */
function retryAfterOf(body: unknown): number | undefined {
  const err = (body as { error?: Record<string, unknown> }).error ?? {};
  const raw = err.retry_after ?? (err.details as Record<string, unknown> | undefined)?.retry_after ?? (body as Record<string, unknown>).retry_after;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Maps MediaListFilters to query params (`filter[purpose]` is a comma list). */
export function mediaListQuery(f: MediaListFilters = {}): Record<string, string | number | undefined> {
  return {
    'filter[purpose]': f.purpose?.length ? f.purpose.join(',') : undefined,
    page: f.page,
    per_page: f.per_page,
  };
}

/** Maps AuditLogFilters to `filter[...]` query params. */
export function auditLogQuery(f: AuditLogFilters = {}): Record<string, string | number | undefined> {
  return {
    'filter[action]': f.action,
    'filter[actor_id]': f.actor_id,
    'filter[actor_type]': f.actor_type,
    'filter[subject_type]': f.subject_type,
    'filter[subject_id]': f.subject_id,
    'filter[created_at][gte]': f.created_from,
    'filter[created_at][lte]': f.created_to,
    page: f.page,
    per_page: f.per_page,
  };
}

/** Reads a cookie value (URL-decoded) from a `document.cookie` string. */
export function readCookie(cookies: string, name: string): string | null {
  for (const part of cookies.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return null;
}

const CSRF_PATH = '/sanctum/csrf-cookie';
const isWrite = (method: string | undefined) => !!method && method !== 'GET' && method !== 'HEAD';

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const makeXhr = options.xhr ?? (typeof XMLHttpRequest !== 'undefined' ? () => new XMLHttpRequest() : undefined);
  const credentials = options.credentials ?? 'same-origin';
  const csrf = options.csrf ?? typeof document !== 'undefined';
  const cookies = options.readCookies ?? (() => (typeof document !== 'undefined' ? document.cookie : ''));
  let csrfPromise: Promise<void> | null = null;

  function buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${baseUrl}${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /** Cross-origin only when `baseUrl` is absolute and differs from the page origin (never in the 4.7 design). */
  function isCrossOrigin(): boolean {
    if (!baseUrl || typeof location === 'undefined') return false;
    try {
      return new URL(baseUrl).origin !== location.origin;
    } catch {
      return false;
    }
  }

  function tenantHeaders(opts: Pick<RequestOptions, 'anonymous' | 'noTenant' | 'tenantId'>): Record<string, string> {
    const headers: Record<string, string> = {};
    if (opts.anonymous || opts.noTenant) return headers;
    const tenantId = opts.tenantId ?? options.getTenantId?.();
    if (tenantId) headers['X-Tenant-Id'] = tenantId;
    return headers;
  }

  const xsrfToken = () => readCookie(cookies(), 'XSRF-TOKEN');

  /**
   * GET /sanctum/csrf-cookie (outside /api/v1): sets `XSRF-TOKEN` and the session cookie. Concurrent callers share
   * one request. Called on boot, after login and logout, and automatically before the first write or after a 419.
   */
  function ensureCsrf(force = false): Promise<void> {
    if (!csrf) return Promise.resolve();
    if (!force && xsrfToken()) return Promise.resolve();
    csrfPromise ??= doFetch(`${baseUrl}${CSRF_PATH}`, { method: 'GET', credentials, headers: { Accept: 'application/json' } })
      .then(() => undefined)
      .catch(() => {
        throw new ApiError(0, 'network_error', 'Unable to reach the server. Check your connection.');
      })
      .finally(() => {
        csrfPromise = null;
      });
    return csrfPromise;
  }

  async function csrfHeaders(method: string | undefined): Promise<Record<string, string>> {
    if (!csrf || !isWrite(method)) return {};
    await ensureCsrf();
    const token = xsrfToken();
    return token ? { 'X-XSRF-TOKEN': token } : {};
  }

  const isCsrfMismatch = (e: unknown) => e instanceof ApiError && e.status === 419;

  function handleError(error: unknown): never {
    if (error instanceof ApiError && error.status === 401) options.onUnauthorized?.(error);
    throw error;
  }

  /** Low-level call returning the full envelope `{ data, meta? }`. A 419 refreshes the CSRF cookie and retries once. */
  async function requestEnvelope<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<ApiSuccess<T> | undefined> {
    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      ...opts.headers,
      ...tenantHeaders(opts),
      ...(await csrfHeaders(method)),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(buildUrl(path, opts.query), {
        credentials,
        ...opts.init,
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError(0, 'network_error', 'Unable to reach the server. Check your connection.');
    }

    try {
      return parseResponse<T>(response.status, response.statusText, await response.text());
    } catch (error) {
      if (csrf && !retried && isCsrfMismatch(error)) {
        await ensureCsrf(true);
        return requestEnvelope<T>(path, opts, true);
      }
      return handleError(error);
    }
  }

  /** Call an endpoint and unwrap `data`. Resolves `undefined` for 202/204 without a body. */
  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const envelope = await requestEnvelope<T>(path, opts);
    return envelope?.data as T;
  }

  /** Multipart POST with progress (XHR); falls back to fetch without progress. 419 → refresh CSRF, retry once. */
  function uploadForm<T>(path: string, form: FormData, opts: UploadOptions = {}, retried = false): Promise<T> {
    // Without CSRF the XHR is opened synchronously (callers and tests can observe it immediately).
    return csrf ? csrfHeaders('POST').then((h) => sendUpload<T>(path, form, opts, retried, h)) : sendUpload<T>(path, form, opts, retried, {});
  }

  async function sendUpload<T>(path: string, form: FormData, opts: UploadOptions, retried: boolean, csrfHeader: Record<string, string>): Promise<T> {
    const url = buildUrl(path);
    const headers = { Accept: 'application/json', ...options.headers, ...tenantHeaders({}), ...csrfHeader };
    const retry = async (error: unknown): Promise<T> => {
      if (csrf && !retried && isCsrfMismatch(error)) {
        await ensureCsrf(true);
        return uploadForm<T>(path, form, opts, true);
      }
      return handleError(error);
    };

    if (!makeXhr) {
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', credentials, headers, body: form, signal: opts.signal });
      } catch {
        throw new ApiError(0, 'network_error', 'Unable to reach the server. Check your connection.');
      }
      try {
        return parseResponse<T>(res.status, res.statusText, await res.text())!.data;
      } catch (error) {
        return retry(error);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const xhr = makeXhr();
      xhr.open('POST', url);
      // Same-origin requests always carry cookies; only a cross-origin client would need withCredentials.
      if (isCrossOrigin() && credentials === 'include') xhr.withCredentials = true;
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        try {
          const envelope = parseResponse<T>(xhr.status, xhr.statusText, xhr.responseText);
          opts.onProgress?.(1);
          resolve(envelope!.data);
        } catch (error) {
          retry(error).then(resolve, reject);
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Upload failed. Check your connection.'));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  }

  function uploadMedia(input: UploadMediaInput, opts: UploadOptions = {}): Promise<Media> {
    const form = new FormData();
    const name = input.filename ?? (input.file instanceof File ? input.file.name : 'upload');
    form.append('file', input.file, name);
    form.append('purpose', input.purpose);
    if (input.alt) form.append('alt', input.alt);
    return uploadForm<Media>('/media', form, opts);
  }

  /** GET a file (CSV) with the session cookie + tenant header; errors still use the JSON envelope. */
  async function requestBlob(path: string, opts: Pick<RequestOptions, 'query' | 'signal'> & { fallbackName: string }): Promise<DownloadedFile> {
    let response: Response;
    try {
      response = await doFetch(buildUrl(path, opts.query), {
        method: 'GET',
        credentials,
        headers: { Accept: 'text/csv, application/json', ...options.headers, ...tenantHeaders({}) },
        signal: opts.signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError(0, 'network_error', 'Unable to reach the server. Check your connection.');
    }
    if (!response.ok) {
      try {
        parseResponse<never>(response.status, response.statusText, await response.text());
      } catch (error) {
        return handleError(error);
      }
    }
    return { blob: await response.blob(), filename: filenameFromDisposition(response.headers.get('Content-Disposition'), opts.fallbackName) };
  }

  /** Unwraps a list envelope with a typed meta (fallback when the server sends none). */
  async function listOf<T, M>(path: string, query: RequestOptions['query'], fallback: M): Promise<{ data: T[]; meta: M }> {
    const envelope = await requestEnvelope<T[]>(path, { query });
    return { data: envelope?.data ?? [], meta: (envelope?.meta as M | undefined) ?? fallback };
  }

  const emptyPage = (): PaginationMeta => ({ current_page: 1, per_page: 25, total: 0, last_page: 1 });
  const emptyOrderCounts = (): OrderListMeta['counts'] => ({
    all: 0, pending_payment: 0, pending: 0, confirmed: 0, ready_to_ship: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0,
  });
  const emptyReturnMeta = (): ReturnListMeta => ({
    ...emptyPage(),
    counts: { open: 0, requested: 0, approved: 0, received: 0, refunded: 0, exchanged: 0, rejected: 0, closed: 0 },
    kpis: { open: 0, return_rate_30d: null, money_lost_amount: 0, restocked_units_month: 0 },
  });
  const emptyShipmentMeta = (): ShipmentListMeta => ({
    ...emptyPage(),
    counts: { all: 0, steadfast: 0, pathao: 0, redx: 0, manual: 0 },
    kpis: {
      in_transit: 0, out_for_delivery_today: 0, delivered_7d: 0, delivery_rate_7d: null,
      problems: { total: 0, delivery_failed: 0, on_hold: 0, returning: 0 },
      cod_held: { total_amount: 0, by_provider: [] },
    },
    last_synced_at: null,
  });
  const store = (storeId: string) => `/stores/${enc(storeId)}`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function report<T>(storeId: string, type: 'sales' | 'profit' | 'delivery', range: ReportRangeQuery): Promise<{ data: T; meta: ReportMeta }> {
    const envelope = await requestEnvelope<T>(`${store(storeId)}/reports/${type}`, { query: { from: range.from || undefined, to: range.to || undefined } });
    if (!envelope) throw new Error('Empty report response');
    return { data: envelope.data, meta: envelope.meta as unknown as ReportMeta };
  }

  return {
    request,
    requestEnvelope: <T>(path: string, opts?: RequestOptions) => requestEnvelope<T>(path, opts),
    /** Contract §7.3: fetch the XSRF-TOKEN cookie (boot, after login/logout). `force` re-fetches. */
    ensureCsrf,

    /** Phase 8.1 super admin (`/admin/*`, see ./admin.ts). Never sends X-Tenant-Id. */
    admin: createAdminApi({ request, requestEnvelope, requestBlob }),

    health: (opts?: RequestOptions) => request<HealthStatus>('/health', { anonymous: true, ...opts }),

    auth: {
      /** Phase 8.1 impersonation: startImpersonation, endImpersonation, sessionInfo (see ./impersonation.ts). */
      ...createImpersonationAuth({ request, requestEnvelope }),
      register: (input: RegisterInput) => request<AuthSessionResponse>('/auth/register', { method: 'POST', body: input, anonymous: true }),
      login: (input: LoginInput) => request<AuthSessionResponse>('/auth/login', { method: 'POST', body: input, anonymous: true }),
      logout: () => request<void>('/auth/logout', { method: 'POST', noTenant: true }),
      /** `User` including `tenants` memberships. */
      me: () => request<MeResponse>('/auth/me', { noTenant: true }),
      /** `/auth/me` plus `meta.session_expires_at` (absolute expiry, contract §3.7). 401 = signed out. */
      session: async (): Promise<{ user: MeResponse; session_expires_at: string | null }> => {
        const envelope = await requestEnvelope<MeResponse>('/auth/me', { noTenant: true });
        return { user: envelope!.data, session_expires_at: (envelope?.meta as MeMeta | undefined)?.session_expires_at ?? null };
      },
      updateProfile: (input: UpdateProfileInput) => request<MeResponse>('/auth/me', { method: 'PATCH', body: input, noTenant: true }),
      /** Regenerates this session; every other session is logged out (`AuthenticateSession`). */
      changePassword: (input: ChangePasswordInput) => request<AuthSessionResponse>('/auth/password', { method: 'PUT', body: input, noTenant: true }),
      /** Always resolves (202) whether or not the email exists. */
      forgotPassword: (input: ForgotPasswordInput) =>
        request<MessageResponse | undefined>('/auth/forgot-password', { method: 'POST', body: input, anonymous: true }),
      /**
       * Addendum A. 202 `{expires_in, resend_in, dev_otp?}`. 429 `otp_rate_limited` → ApiError with
       * `retryAfter` (seconds). `dev_otp` only appears in local dev with the log SMS driver.
       */
      sendOtp: (input: SendOtpInput) =>
        // verify_phone needs the signed-in session; login/reset are public.
        request<SendOtpResponse>('/auth/otp/send', { method: 'POST', body: input, noTenant: true, anonymous: input.purpose !== 'verify_phone' }),
      verifyPhone: (input: VerifyPhoneInput) => request<User>('/auth/phone/verify', { method: 'POST', body: input, noTenant: true }),
      /** Same shape as password login. Wrong code → 422 `invalid_otp`. */
      loginWithOtp: (input: OtpLoginInput) => request<AuthSessionResponse>('/auth/login/otp', { method: 'POST', body: input, anonymous: true }),
      resetPasswordWithOtp: (input: OtpResetPasswordInput) =>
        request<MessageResponse>('/auth/reset-password/otp', { method: 'POST', body: input, anonymous: true }),
      /** 422 `invalid_reset_token` for unknown/expired/used tokens. */
      resetPassword: (input: ResetPasswordInput) =>
        request<MessageResponse>('/auth/reset-password', { method: 'POST', body: input, anonymous: true }),
    },

    stores: {
      /** Tenant-scoped (X-Tenant-Id). Contract D1: a tenant has at most one store. */
      list: async (query?: { page?: number; per_page?: number }, opts?: { tenantId?: string }): Promise<Paginated<Store[]>> => {
        const envelope = await requestEnvelope<Store[]>('/stores', { query, tenantId: opts?.tenantId });
        return { data: envelope?.data ?? [], meta: envelope?.meta };
      },
      get: (storeId: string) => request<Store>(`/stores/${enc(storeId)}`),
      /** 409 `store_limit_reached` when the tenant already has its store. */
      create: (input: CreateStoreInput) => request<Store>('/stores', { method: 'POST', body: input }),
      getSettings: (storeId: string) => request<StoreSettings>(`/stores/${enc(storeId)}/settings`),
      /** Partial update: only sections/keys present change; `null` clears. */
      updateSettings: (storeId: string, input: UpdateStoreSettingsInput) =>
        request<StoreSettings>(`/stores/${enc(storeId)}/settings`, { method: 'PATCH', body: input }),
      /** Short-lived signed link to preview a draft store (opens `url` in a new tab). */
      createPreviewToken: (storeId: string) => request<PreviewToken>(`/stores/${enc(storeId)}/preview-token`, { method: 'POST' }),
    },

    staff: {
      list: async (): Promise<{ data: StaffMember[]; meta: StaffSeatsMeta }> => {
        const envelope = await requestEnvelope<StaffMember[]>('/staff');
        return { data: envelope?.data ?? [], meta: (envelope?.meta as StaffSeatsMeta | undefined) ?? { seats_used: 0, seats_limit: null } };
      },
      invite: (input: InviteStaffInput) => request<StaffMember>('/staff/invitations', { method: 'POST', body: input }),
      resendInvitation: (invitationId: string) =>
        request<StaffMember>(`/staff/invitations/${enc(invitationId)}/resend`, { method: 'POST' }),
      revokeInvitation: (invitationId: string) => request<void>(`/staff/invitations/${enc(invitationId)}`, { method: 'DELETE' }),
      updateRole: (memberId: string, input: UpdateStaffRoleInput) =>
        request<StaffMember>(`/staff/${enc(memberId)}`, { method: 'PATCH', body: input }),
      /** Removing yourself = leaving the shop. */
      remove: (memberId: string) => request<void>(`/staff/${enc(memberId)}`, { method: 'DELETE' }),
    },

    /** PHASE-8-3 §6.1: the code-defined permission catalogue (needs `staff.manage`). */
    permissions: {
      list: () => request<PermissionGroup[]>('/permissions'),
    },

    /**
     * PHASE-8-3 §6.1 roles. Writes: 402 `feature_not_in_plan` (custom roles need Growth), 403 `permission_not_held` /
     * `cannot_edit_own_role`, 409 `system_role_locked` / `revision_conflict` / `role_limit_reached` / `role_in_use`.
     */
    roles: {
      list: async (): Promise<{ data: Role[]; meta: RolesMeta }> =>
        listOf<Role, RolesMeta>('/roles', undefined, { custom_roles_used: 0, custom_roles_limit: 20, custom_roles_enabled: false }),
      get: (roleId: string) => request<RoleDetail>(`/roles/${enc(roleId)}`),
      create: (input: CreateRoleInput) => request<RoleDetail>('/roles', { method: 'POST', body: input }),
      /** `revision` is required; `permissions` replaces the set. */
      update: (roleId: string, input: UpdateRoleInput) => request<RoleDetail>(`/roles/${enc(roleId)}`, { method: 'PATCH', body: input }),
      /**
       * 409 `role_in_use` (details.members / details.invitations) unless `reassign_to` moves them first.
       * `revision` is required (SEC-L3): a stale one → 409 `revision_conflict`.
       */
      remove: (roleId: string, opts: { revision: number; reassign_to?: string }) =>
        request<void>(`/roles/${enc(roleId)}`, { method: 'DELETE', query: { revision: opts.revision, reassign_to: opts.reassign_to || undefined } }),
    },

    invitations: {
      preview: (token: string) => request<InvitationPreview>(`/invitations/${enc(token)}`, { anonymous: true }),
      /** New user: pass `input` → `AuthSession` (201, session cookie). Signed-in existing user: omit → `TenantMembership` (200). */
      accept: ((token: string, input?: AcceptInvitationInput) =>
        input
          ? request<AuthSessionResponse>(`/invitations/${enc(token)}/accept`, { method: 'POST', body: input, anonymous: true })
          : request<TenantMembership>(`/invitations/${enc(token)}/accept`, { method: 'POST', noTenant: true })) as {
        (token: string, input: AcceptInvitationInput): Promise<AuthSessionResponse>;
        (token: string): Promise<TenantMembership>;
      },
    },

    media: {
      upload: uploadMedia,
      /** Phase 3 §3.5: newest first, excludes `failed`. Used by the editor media picker. */
      list: async (filters: MediaListFilters = {}): Promise<Paginated<Media[]>> => {
        const envelope = await requestEnvelope<Media[]>('/media', { query: mediaListQuery(filters) });
        return { data: envelope?.data ?? [], meta: envelope?.meta };
      },
      get: (mediaId: string) => request<Media>(`/media/${enc(mediaId)}`),
      /** 409 `media_in_use` when it is the current logo/favicon. */
      delete: (mediaId: string) => request<void>(`/media/${enc(mediaId)}`, { method: 'DELETE' }),
      /** Polls every `intervalMs` (1 s) up to `timeoutMs` (30 s) until status leaves `processing`. */
      async waitUntilProcessed(media: Media, { intervalMs = 1000, timeoutMs = 30_000 } = {}): Promise<Media> {
        let current = media;
        const deadline = Date.now() + timeoutMs;
        while (current.status === 'processing' && Date.now() < deadline) {
          await sleep(intervalMs);
          current = await request<Media>(`/media/${enc(current.id)}`);
        }
        return current;
      },
    },

    /** Phase 3 §3.1: theme registry (all library themes, incl. `coming_soon`). */
    themes: {
      catalog: () => request<ThemeCatalogEntry[]>('/themes'),
    },

    /** Phase 3 §3.1: a store's installed themes with draft/publish. `code` is the theme code, e.g. `modern-commerce`. */
    storeThemes: {
      list: (storeId: string) => request<StoreThemeSummary[]>(`/stores/${enc(storeId)}/themes`),
      get: (storeId: string, code: string) => request<StoreTheme>(`/stores/${enc(storeId)}/themes/${enc(code)}`),
      /** 409 `revision_conflict` when `base_revision` is stale; 422 `validation_failed` / `theme_mismatch`; 413. */
      saveDraft: (storeId: string, code: string, input: SaveThemeDraftInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<StoreTheme>(`/stores/${enc(storeId)}/themes/${enc(code)}/draft`, { method: 'PUT', body: input, signal: opts?.signal }),
      /** 409 `revision_conflict` / `theme_not_active`. */
      publish: (storeId: string, code: string, input: PublishThemeInput) =>
        request<StoreTheme>(`/stores/${enc(storeId)}/themes/${enc(code)}/publish`, { method: 'POST', body: input }),
      /** Draft := published. 409 `nothing_published`. */
      discard: (storeId: string, code: string) => request<StoreTheme>(`/stores/${enc(storeId)}/themes/${enc(code)}/discard`, { method: 'POST' }),
      /** Install (if needed) and activate. 409 `theme_unavailable` for coming-soon or premium themes. */
      apply: (storeId: string, code: string) => request<StoreTheme>(`/stores/${enc(storeId)}/themes/${enc(code)}/apply`, { method: 'POST' }),
    },

    pageTemplates: {
      list: () => request<PageTemplate[]>('/page-templates'),
    },

    /** Phase 3 §3.2: pages save live (no draft copy); `revision` guards concurrent edits (409 `revision_conflict`). */
    pages: {
      list: async (storeId: string, filters: { status?: PageStatus[]; q?: string } = {}): Promise<{ data: StorePageSummary[]; meta: PageListMeta }> => {
        const envelope = await requestEnvelope<StorePageSummary[]>(`/stores/${enc(storeId)}/pages`, {
          query: { 'filter[status]': filters.status?.length ? filters.status.join(',') : undefined, q: filters.q || undefined },
        });
        const fallback: PageListMeta = { counts: { all: 0, draft: 0, published: 0, hidden: 0 }, limit: 50 };
        return { data: envelope?.data ?? [], meta: (envelope?.meta as PageListMeta | undefined) ?? fallback };
      },
      get: (storeId: string, pageId: string) => request<StorePage>(`/stores/${enc(storeId)}/pages/${enc(pageId)}`),
      /** 409 `page_limit_reached` (50). */
      create: (storeId: string, input: CreatePageInput) => request<StorePage>(`/stores/${enc(storeId)}/pages`, { method: 'POST', body: input }),
      update: (storeId: string, pageId: string, input: UpdatePageInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<StorePage>(`/stores/${enc(storeId)}/pages/${enc(pageId)}`, { method: 'PATCH', body: input, signal: opts?.signal }),
      delete: (storeId: string, pageId: string) => request<void>(`/stores/${enc(storeId)}/pages/${enc(pageId)}`, { method: 'DELETE' }),
    },

    /** Phase 3 §3.3: always the three menus `main`, `footer`, `help` in that order. */
    navigation: {
      list: (storeId: string) => request<NavigationMenu[]>(`/stores/${enc(storeId)}/navigation`),
      /** Saves the whole menu. 409 `revision_conflict`; 422 for depth/count/link errors. */
      save: (storeId: string, handle: NavigationHandle, input: SaveNavigationInput) =>
        request<NavigationMenu>(`/stores/${enc(storeId)}/navigation/${enc(handle)}`, { method: 'PUT', body: input }),
    },

    plans: { list: () => request<Plan[]>('/plans', { anonymous: true }) },
    subscription: { get: () => request<Subscription>('/subscription') },
    features: { get: () => request<FeatureAccess>('/features') },

    auditLogs: {
      list: async (filters?: AuditLogFilters): Promise<Paginated<AuditLog[]>> => {
        const envelope = await requestEnvelope<AuditLog[]>('/audit-logs', { query: auditLogQuery(filters) });
        return { data: envelope?.data ?? [], meta: envelope?.meta };
      },
    },

    /** Phase 4 §3.1: flat depth-first tree, max 500, not paginated. */
    categories: {
      list: async (storeId: string, q?: string): Promise<{ data: Category[]; meta: { count: number; limit: number } }> =>
        listOf<Category, { count: number; limit: number }>(`${store(storeId)}/categories`, { q: q?.trim() || undefined }, { count: 0, limit: 500 }),
      get: (storeId: string, id: string) => request<Category>(`${store(storeId)}/categories/${enc(id)}`),
      /** 409 `category_limit_reached`; 422 depth/slug. */
      create: (storeId: string, input: CreateCategoryInput) => request<Category>(`${store(storeId)}/categories`, { method: 'POST', body: input }),
      update: (storeId: string, id: string, input: UpdateCategoryInput) =>
        request<Category>(`${store(storeId)}/categories/${enc(id)}`, { method: 'PATCH', body: input }),
      /** Every category of the store in display order. */
      reorder: (storeId: string, input: ReorderCategoriesInput) => request<Category[]>(`${store(storeId)}/categories/order`, { method: 'PUT', body: input }),
      /** 409 `category_has_children`. O A only. */
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/categories/${enc(id)}`, { method: 'DELETE' }),
    },

    /** Phase 4 §3.2. PATCH needs `revision` (409 `revision_conflict`); create/duplicate can 402 `plan_limit_reached`. */
    products: {
      list: (storeId: string, filters: ProductListFilters = {}) =>
        listOf<ProductSummary, ProductListMeta>(`${store(storeId)}/products`, productListQuery(filters), {
          ...emptyPage(),
          counts: { all: 0, draft: 0, active: 0, archived: 0 },
          summary: { active_products: 0, active_variants: 0, low_stock_variants: 0, out_of_stock_variants: 0 },
          plan: { limit: null, used: 0 },
        }),
      get: (storeId: string, id: string) => request<Product>(`${store(storeId)}/products/${enc(id)}`),
      create: (storeId: string, input: CreateProductInput) => request<Product>(`${store(storeId)}/products`, { method: 'POST', body: input }),
      update: (storeId: string, id: string, input: UpdateProductInput) =>
        request<Product>(`${store(storeId)}/products/${enc(id)}`, { method: 'PATCH', body: input }),
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/products/${enc(id)}`, { method: 'DELETE' }),
      duplicate: (storeId: string, id: string) => request<Product>(`${store(storeId)}/products/${enc(id)}/duplicate`, { method: 'POST' }),
      bulk: (storeId: string, input: ProductBulkInput) => request<ProductBulkResult>(`${store(storeId)}/products/bulk`, { method: 'POST', body: input }),
    },

    /** Phase 4 §3.3. Stock changes only through `adjust` (atomic, never negative). */
    inventory: {
      list: (storeId: string, filters: InventoryListFilters = {}) =>
        listOf<InventoryItem, InventoryListMeta>(`${store(storeId)}/inventory`, inventoryListQuery(filters), {
          ...emptyPage(),
          summary: {
            currency: 'BDT',
            stock_value_cost_amount: null,
            stock_value_price_amount: 0,
            units_on_hand: 0,
            committed_units: 0,
            low_stock_variants: 0,
            out_of_stock_variants: 0,
            variants_count: 0,
            products_count: 0,
          },
        }),
      setThreshold: (storeId: string, variantId: string, lowStockThreshold: number | null) =>
        request<InventoryItem>(`${store(storeId)}/inventory/${enc(variantId)}`, { method: 'PATCH', body: { low_stock_threshold: lowStockThreshold } }),
      /** 409 `stock_changed`; 422 `insufficient_stock`. */
      adjust: (storeId: string, input: StockAdjustmentInput) =>
        request<StockAdjustmentResult>(`${store(storeId)}/inventory/adjustments`, { method: 'POST', body: input }),
      movements: (storeId: string, filters: StockMovementFilters = {}) =>
        listOf<StockMovement, PaginationMeta>(`${store(storeId)}/inventory/movements`, movementListQuery(filters), emptyPage()),
    },

    /** Phase 4 §3.5. PATCH needs `revision`. */
    customers: {
      list: (storeId: string, filters: CustomerListFilters = {}) =>
        listOf<Customer, CustomerListMeta>(`${store(storeId)}/customers`, customerListQuery(filters), { ...emptyPage(), counts: { all: 0, new_this_month: 0 } }),
      get: (storeId: string, id: string) => request<CustomerDetail>(`${store(storeId)}/customers/${enc(id)}`),
      create: (storeId: string, input: CreateCustomerInput) => request<CustomerDetail>(`${store(storeId)}/customers`, { method: 'POST', body: input }),
      update: (storeId: string, id: string, input: UpdateCustomerInput) =>
        request<CustomerDetail>(`${store(storeId)}/customers/${enc(id)}`, { method: 'PATCH', body: input }),
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/customers/${enc(id)}`, { method: 'DELETE' }),
      addNote: (storeId: string, id: string, body: string) =>
        request<CustomerNote>(`${store(storeId)}/customers/${enc(id)}/notes`, { method: 'POST', body: { body } }),
      deleteNote: (storeId: string, id: string, noteId: string) =>
        request<void>(`${store(storeId)}/customers/${enc(id)}/notes/${enc(noteId)}`, { method: 'DELETE' }),
      /** PHASE-8-5 §4.1 "Stop marketing messages" (`customers.edit`): adds a `merchant` suppression; idempotent. */
      marketingOptOut: (storeId: string, id: string, channel: MarketingChannel) =>
        request<CustomerMarketing>(`${store(storeId)}/customers/${enc(id)}/marketing-opt-out`, { method: 'POST', body: { channel } }),
      /** "Allow again": removes a `merchant` suppression only; a customer-owned one → 409 `suppression_customer_owned`. */
      removeMarketingOptOut: (storeId: string, id: string, channel: MarketingChannel) =>
        request<CustomerMarketing>(`${store(storeId)}/customers/${enc(id)}/marketing-opt-out/${enc(channel)}`, { method: 'DELETE' }),
    },

    /** Phase 4 §3.4 (O A only). Poll `get` every 2 s while `validating`/`importing`. */
    imports: {
      template: (storeId: string, type: DataImportType) =>
        requestBlob(`${store(storeId)}/imports/template`, { query: { type }, fallbackName: `storeplix-${type}-template.csv` }),
      upload: (storeId: string, input: { file: Blob; type: DataImportType; filename?: string }, opts?: UploadOptions) => {
        const form = new FormData();
        form.append('file', input.file, input.filename ?? (input.file instanceof File ? input.file.name : 'import.csv'));
        form.append('type', input.type);
        return uploadForm<DataImport>(`${store(storeId)}/imports`, form, opts);
      },
      get: (storeId: string, id: string) => request<DataImport>(`${store(storeId)}/imports/${enc(id)}`),
      validate: (storeId: string, id: string, input: ValidateImportInput) =>
        request<DataImport>(`${store(storeId)}/imports/${enc(id)}/validate`, { method: 'POST', body: input }),
      rows: (storeId: string, id: string, filters: { status?: DataImportRow['status'][]; page?: number; per_page?: number } = {}) =>
        listOf<DataImportRow, PaginationMeta>(
          `${store(storeId)}/imports/${enc(id)}/rows`,
          { 'filter[status]': filters.status?.length ? filters.status.join(',') : undefined, page: filters.page, per_page: filters.per_page },
          emptyPage(),
        ),
      errorReport: (storeId: string, id: string) =>
        requestBlob(`${store(storeId)}/imports/${enc(id)}/error-report`, { fallbackName: 'import-errors.csv' }),
      /** 402 `plan_limit_reached` unless `allow_partial`. */
      run: (storeId: string, id: string, input: RunImportInput = {}) =>
        request<DataImport>(`${store(storeId)}/imports/${enc(id)}/run`, { method: 'POST', body: input }),
      cancel: (storeId: string, id: string) => request<void>(`${store(storeId)}/imports/${enc(id)}`, { method: 'DELETE' }),
    },

    exports: {
      create: (storeId: string, input: CreateExportInput) => request<DataExport>(`${store(storeId)}/exports`, { method: 'POST', body: input }),
      /** `download_url` is a fresh 5-minute signed URL each call once `completed`. */
      get: (storeId: string, id: string) => request<DataExport>(`${store(storeId)}/exports/${enc(id)}`),
    },

    /** Phase 5a §3.1: public, cacheable 24 h. */
    geo: {
      bd: () => request<BdGeo>('/geo/bd', { anonymous: true }),
    },

    /** Phase 5a §3.5. Reads O A S; writes O A (`ManageSettings`). PUT is a full replacement of zones. */
    shipping: {
      get: (storeId: string) => request<ShippingSettings>(`${store(storeId)}/shipping`),
      save: (storeId: string, input: SaveShippingInput) => request<ShippingSettings>(`${store(storeId)}/shipping`, { method: 'PUT', body: input }),
      createPickup: (storeId: string, input: PickupLocationInput) =>
        request<PickupLocation>(`${store(storeId)}/pickup-locations`, { method: 'POST', body: input }),
      updatePickup: (storeId: string, id: string, input: Partial<PickupLocationInput>) =>
        request<PickupLocation>(`${store(storeId)}/pickup-locations/${enc(id)}`, { method: 'PATCH', body: input }),
      deletePickup: (storeId: string, id: string) => request<void>(`${store(storeId)}/pickup-locations/${enc(id)}`, { method: 'DELETE' }),
    },

    /** Phase 5a §3.6. Reads O A S; writes O A (`ManageMarketing`). PATCH needs `revision`. */
    coupons: {
      list: (storeId: string, filters: CouponListFilters = {}) =>
        listOf<Coupon, CouponListMeta>(`${store(storeId)}/coupons`, couponListQuery(filters), { ...emptyPage(), counts: { all: 0, active: 0, scheduled: 0, expired: 0 } }),
      get: (storeId: string, id: string) => request<Coupon>(`${store(storeId)}/coupons/${enc(id)}`),
      create: (storeId: string, input: CreateCouponInput) => request<Coupon>(`${store(storeId)}/coupons`, { method: 'POST', body: input }),
      update: (storeId: string, id: string, input: UpdateCouponInput) =>
        request<Coupon>(`${store(storeId)}/coupons/${enc(id)}`, { method: 'PATCH', body: input }),
      /** 409 `coupon_in_use` once redeemed. */
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/coupons/${enc(id)}`, { method: 'DELETE' }),
    },

    /** Phase 5a §3.7. Transitions return the updated `Order`; invalid → 409 `invalid_state_transition`. */
    orders: {
      list: (storeId: string, filters: OrderListFilters = {}) =>
        listOf<OrderSummary, OrderListMeta>(`${store(storeId)}/orders`, orderListQuery(filters), { ...emptyPage(), counts: emptyOrderCounts() }),
      get: (storeId: string, id: string) => request<Order>(`${store(storeId)}/orders/${enc(id)}`),
      quote: (storeId: string, input: ManualOrderInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<OrderQuote>(`${store(storeId)}/orders/quote`, { method: 'POST', body: input, signal: opts?.signal }),
      /** `idempotencyKey` is created once per form session and reused on every retry (§9.1). 402 at the plan limit. */
      create: (storeId: string, input: ManualOrderInput, idempotencyKey: string) =>
        request<Order>(`${store(storeId)}/orders`, { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
      /** 200 `Order` + `meta.shipping_hint` (P5-20). */
      update: async (storeId: string, id: string, input: UpdateOrderInput): Promise<{ order: Order; shippingHint: ShippingQuote | null }> => {
        const envelope = await requestEnvelope<Order>(`${store(storeId)}/orders/${enc(id)}`, { method: 'PATCH', body: input });
        const meta = (envelope?.meta ?? {}) as { shipping_hint?: ShippingQuote | null };
        return { order: envelope!.data, shippingHint: meta.shipping_hint ?? null };
      },
      confirm: (storeId: string, id: string, input: { notify_customer?: boolean } = {}) =>
        request<Order>(`${store(storeId)}/orders/${enc(id)}/confirm`, { method: 'POST', body: input }),
      ready: (storeId: string, id: string) => request<Order>(`${store(storeId)}/orders/${enc(id)}/ready`, { method: 'POST' }),
      ship: (storeId: string, id: string, input: ShipOrderInput) => request<Order>(`${store(storeId)}/orders/${enc(id)}/ship`, { method: 'POST', body: input }),
      deliver: (storeId: string, id: string) => request<Order>(`${store(storeId)}/orders/${enc(id)}/deliver`, { method: 'POST' }),
      return: (storeId: string, id: string, input: ReturnOrderInput) =>
        request<Order>(`${store(storeId)}/orders/${enc(id)}/return`, { method: 'POST', body: input }),
      /** Staff on a paid order → 403. 5b: `refund_to_gateway` (default true when paid online, P5B-25). */
      cancel: (storeId: string, id: string, input: CancelOrderInput) =>
        request<Order>(`${store(storeId)}/orders/${enc(id)}/cancel`, { method: 'POST', body: input }),
      bulk: (storeId: string, input: OrderBulkInput) => request<OrderBulkResult>(`${store(storeId)}/orders/bulk`, { method: 'POST', body: input }),
      addNote: (storeId: string, id: string, body: string) =>
        request<OrderEvent>(`${store(storeId)}/orders/${enc(id)}/notes`, { method: 'POST', body: { body } }),
      /**
       * O A only; 422 `refund_exceeds_paid`. 5b: `method: 'gateway'` + `payment_id` refunds through the gateway (201
       * `Payment`, `pending` until the provider confirms); 422 `gateway_refund_rejected`, 502 `provider_unavailable`.
       */
      refund: (storeId: string, id: string, input: RefundInput, idempotencyKey: string) =>
        request<Payment>(`${store(storeId)}/orders/${enc(id)}/refunds`, { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
      /** 5b §4.9 (P5B-61): same math as `editItems`, no writes. */
      quoteItems: (storeId: string, id: string, input: EditOrderItemsInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<OrderItemsQuote>(`${store(storeId)}/orders/${enc(id)}/items/quote`, { method: 'POST', body: input, signal: opts?.signal }),
      /** 5b §4.9 (P5B-60): full desired line set. 200 `Order` + `meta.notices`; 409 `shipment_booked`; 422 `total_below_paid`. */
      editItems: async (storeId: string, id: string, input: EditOrderItemsInput): Promise<{ order: Order; notices: string[] }> => {
        const envelope = await requestEnvelope<Order>(`${store(storeId)}/orders/${enc(id)}/items`, { method: 'PUT', body: input });
        const meta = (envelope?.meta ?? {}) as { notices?: string[] };
        return { order: envelope!.data, notices: meta.notices ?? [] };
      },
      /** 5b P5B-69: `returned` orders, cumulative up to the shipped quantity. */
      restock: (storeId: string, id: string, input: RestockInput) => request<Order>(`${store(storeId)}/orders/${enc(id)}/restock`, { method: 'POST', body: input }),
      /** 5b P5B-63: delivered orders; 409 `return_not_allowed`. */
      createReturn: (storeId: string, id: string, input: CreateReturnInput) =>
        request<ReturnRequest>(`${store(storeId)}/orders/${enc(id)}/returns`, { method: 'POST', body: input }),
    },

    /**
     * Phase 5b §4.1 payment gateways. Reads O A S; writes O A (`ManageIntegrations`). Secrets are write-only: the
     * response carries `credentials_hint` only. `connect` = PUT (API checks the credentials first; 422
     * `credentials_invalid`, 502 `provider_unavailable`); `disconnect` → 409 `gateway_busy` with pending money.
     */
    paymentGateways: {
      list: (storeId: string) => request<PaymentGatewayAccount[]>(`${store(storeId)}/payment-gateways`),
      connect: (storeId: string, provider: GatewayProvider, input: ConnectGatewayInput) =>
        request<PaymentGatewayAccount>(`${store(storeId)}/payment-gateways/${enc(provider)}`, { method: 'PUT', body: input }),
      /** `enabled` (checkout method) and `is_default`; 409 `revision_conflict`, 422 `gateway_not_connected`. */
      update: (storeId: string, provider: GatewayProvider, input: UpdateGatewayInput) =>
        request<PaymentGatewayAccount>(`${store(storeId)}/payment-gateways/${enc(provider)}`, { method: 'PATCH', body: input }),
      /** ৳ 10 sandbox / ৳ 1 live; open `redirect_url` in a new tab, then poll `list` for `verified_at`. */
      testPayment: (storeId: string, provider: GatewayProvider, idempotencyKey: string) =>
        request<GatewayTestPayment>(`${store(storeId)}/payment-gateways/${enc(provider)}/test-payment`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
      disconnect: (storeId: string, provider: GatewayProvider) => request<void>(`${store(storeId)}/payment-gateways/${enc(provider)}`, { method: 'DELETE' }),
    },

    /**
     * Phase 5b §4.6 couriers (WEB-1). Reads O A S; writes O A (`ManageIntegrations`). `list` returns all three providers
     * (`not_connected` when absent). `connect` = PUT: 402 `plan_limit_reached` (courier_connections), 422
     * `credentials_invalid`, 502 `provider_unavailable`; the webhook secret comes back once in `meta.webhook_secret`.
     * `update` = PATCH with `revision` (409 `revision_conflict`); `disconnect` → 409 `courier_busy` with active parcels.
     */
    couriers: {
      list: (storeId: string) => request<CourierAccount[]>(`${store(storeId)}/couriers`),
      connect: async (storeId: string, provider: CourierProvider, input: ConnectCourierInput): Promise<CourierConnectResult> => {
        const envelope = await requestEnvelope<CourierAccount>(`${store(storeId)}/couriers/${enc(provider)}`, { method: 'PUT', body: input });
        const secret = (envelope?.meta as { webhook_secret?: string | null } | undefined)?.webhook_secret;
        return { account: envelope!.data, webhook_secret: secret ?? null };
      },
      update: (storeId: string, provider: CourierProvider, input: UpdateCourierInput) =>
        request<CourierAccount>(`${store(storeId)}/couriers/${enc(provider)}`, { method: 'PATCH', body: input }),
      test: (storeId: string, provider: CourierProvider) => request<CourierTestResult>(`${store(storeId)}/couriers/${enc(provider)}/test`, { method: 'POST' }),
      rotateWebhookSecret: (storeId: string, provider: CourierProvider) =>
        request<CourierWebhookSecret>(`${store(storeId)}/couriers/${enc(provider)}/webhook-secret`, { method: 'POST' }),
      disconnect: (storeId: string, provider: CourierProvider) => request<void>(`${store(storeId)}/couriers/${enc(provider)}`, { method: 'DELETE' }),
      areas: async (storeId: string, provider: CourierProvider, query: CourierAreaQuery): Promise<CourierAreaList> => {
        const envelope = await requestEnvelope<CourierArea[]>(`${store(storeId)}/couriers/${enc(provider)}/areas`, { query: { ...query } });
        const suggested = (envelope?.meta as { suggested?: CourierAreaList['suggested'] } | undefined)?.suggested;
        return { data: envelope?.data ?? [], suggested: suggested ?? null };
      },
      pickupStores: (storeId: string, provider: CourierProvider) => request<CourierPickupStore[]>(`${store(storeId)}/couriers/${enc(provider)}/pickup-stores`),
    },

    /** Phase 5b §4.4 payment links ("Ask for an advance", P5B-22). O A S. One active link per order (409 `payment_link_active`). */
    paymentLinks: {
      list: (storeId: string, orderId: string) => request<PaymentLink[]>(`${store(storeId)}/orders/${enc(orderId)}/payment-links`),
      create: (storeId: string, orderId: string, input: CreatePaymentLinkInput, idempotencyKey: string) =>
        request<PaymentLink>(`${store(storeId)}/orders/${enc(orderId)}/payment-links`, { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
      /** SMS again; 3 per link per hour (429). */
      resend: (storeId: string, orderId: string, linkId: string) =>
        request<PaymentLink>(`${store(storeId)}/orders/${enc(orderId)}/payment-links/${enc(linkId)}/resend`, { method: 'POST' }),
      cancel: (storeId: string, orderId: string, linkId: string) => request<void>(`${store(storeId)}/orders/${enc(orderId)}/payment-links/${enc(linkId)}`, { method: 'DELETE' }),
    },

    /** Phase 5b §4.9 returns and exchanges. Transitions return the updated `ReturnRequest`; invalid → 409. */
    returns: {
      list: (storeId: string, filters: ReturnListFilters = {}) =>
        listOf<ReturnSummary, ReturnListMeta>(`${store(storeId)}/returns`, returnListQuery(filters), emptyReturnMeta()),
      get: (storeId: string, id: string) => request<ReturnRequest>(`${store(storeId)}/returns/${enc(id)}`),
      approve: (storeId: string, id: string, input: { pickup_tracking_code?: string | null; note?: string | null } = {}) =>
        request<ReturnRequest>(`${store(storeId)}/returns/${enc(id)}/approve`, { method: 'POST', body: input }),
      reject: (storeId: string, id: string, input: { reason: string }) =>
        request<ReturnRequest>(`${store(storeId)}/returns/${enc(id)}/reject`, { method: 'POST', body: input }),
      receive: (storeId: string, id: string, input: ReceiveReturnInput) =>
        request<ReturnRequest>(`${store(storeId)}/returns/${enc(id)}/receive`, { method: 'POST', body: input }),
      close: (storeId: string, id: string, input: { note?: string | null } = {}) =>
        request<ReturnRequest>(`${store(storeId)}/returns/${enc(id)}/close`, { method: 'POST', body: input }),
      /** P5B-67: new manual order with the exchange credit. Idempotency-Key required; 402 at the plan limit. */
      exchangeOrder: (storeId: string, id: string, input: ExchangeOrderInput, idempotencyKey: string) =>
        request<{ return: ReturnRequest; order: Order; payment_link: PaymentLink | null }>(`${store(storeId)}/returns/${enc(id)}/exchange-order`, {
          method: 'POST',
          body: input,
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      addNote: (storeId: string, id: string, body: string) => request<ReturnEvent>(`${store(storeId)}/returns/${enc(id)}/notes`, { method: 'POST', body: { body } }),
    },

    /**
     * Phase 5b §4.7 shipments (O A S `Operate`). `book`: Idempotency-Key required; 201 `Shipment` (`booked`, or `booking`
     * on a courier timeout); 409 `shipment_booked`; 422 `courier_rejected`, `gateway_not_connected`; 403 when staff send
     * `cod_amount`; 502 `provider_unavailable`. `bulk`: 202 `ShipmentBatch`, poll `batch`; 402 `feature_not_in_plan`.
     * `cancel` → 409 `courier_cancel_unsupported` when the courier has no cancel API: cancel in the courier panel, then
     * `markCancelled`. `sync` is throttled 1/min per store (429).
     */
    shipments: {
      book: (storeId: string, orderId: string, input: BookShipmentInput, idempotencyKey: string) =>
        request<Shipment>(`${store(storeId)}/orders/${enc(orderId)}/shipments`, { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
      bulk: (storeId: string, input: { provider: CourierProvider; order_ids: string[] }) =>
        request<ShipmentBatch>(`${store(storeId)}/shipments/bulk`, { method: 'POST', body: input }),
      batch: (storeId: string, id: string, opts?: Pick<RequestOptions, 'signal'>) =>
        request<ShipmentBatch>(`${store(storeId)}/shipment-batches/${enc(id)}`, { signal: opts?.signal }),
      list: (storeId: string, filters: ShipmentListFilters = {}) =>
        listOf<ShipmentSummary, ShipmentListMeta>(`${store(storeId)}/shipments`, shipmentListQuery(filters), emptyShipmentMeta()),
      get: (storeId: string, id: string) => request<ShipmentDetail>(`${store(storeId)}/shipments/${enc(id)}`),
      /** Throttle 6/min per shipment (429); 502 `provider_unavailable`. */
      refresh: (storeId: string, id: string) => request<ShipmentDetail>(`${store(storeId)}/shipments/${enc(id)}/refresh`, { method: 'POST' }),
      sync: (storeId: string) => request<{ queued: number }>(`${store(storeId)}/shipments/sync`, { method: 'POST' }),
      cancel: (storeId: string, id: string, input: { reason?: string | null } = {}) =>
        request<Shipment>(`${store(storeId)}/shipments/${enc(id)}/cancel`, { method: 'POST', body: input }),
      markCancelled: (storeId: string, id: string, input: { note?: string | null } = {}) =>
        request<Shipment>(`${store(storeId)}/shipments/${enc(id)}/mark-cancelled`, { method: 'POST', body: input }),
    },

    /** Phase 5b §4.8 documents. Generation is queued: create → poll `get` until `ready` → open `download_url` (5-min signed). */
    documents: {
      templates: (storeId: string) => request<DocumentTemplate[]>(`${store(storeId)}/document-templates`),
      /** O A (`ManageSettings`); 409 `revision_conflict`. */
      saveTemplate: (storeId: string, kind: DocumentKind, input: { revision?: number; config: DocumentTemplateConfig }) =>
        request<DocumentTemplate>(`${store(storeId)}/document-templates/${enc(kind)}`, { method: 'PUT', body: input }),
      /** 202 `queued`; 409 `conflict` beyond 10 queued per store. */
      create: (storeId: string, input: CreateDocumentInput) => request<StoreDocument>(`${store(storeId)}/documents`, { method: 'POST', body: input }),
      get: (storeId: string, id: string, opts?: Pick<RequestOptions, 'signal'>) => request<StoreDocument>(`${store(storeId)}/documents/${enc(id)}`, { signal: opts?.signal }),
      /** Sanitised HTML for the sandboxed preview iframe (throttle 30/min). */
      preview: (storeId: string, input: { kind: DocumentKind; config?: DocumentTemplateConfig; order_id?: string | null }, opts?: Pick<RequestOptions, 'signal'>) =>
        request<{ html: string }>(`${store(storeId)}/documents/preview`, { method: 'POST', body: input, signal: opts?.signal }),
    },

    /**
     * Phase 6 §4.1 custom domains. Reads O A S; writes O A (`ManageDomains`, 403 for staff). Errors: add → 402
     * `feature_not_in_plan` | `plan_limit_reached`, 422 `domain_invalid` | `domain_reserved` | `domain_taken`; verify → 409
     * `platform_domain_locked` | `invalid_state_transition`, 429 with `retryAfter` (6/min, 30/hour per domain); primary →
     * 409 `domain_not_active`, 402; remove → 409 `platform_domain_locked`. Another store's id → 404.
     */
    domains: {
      /** Platform rows first, then custom by `created_at`; `meta` carries the CNAME target, plan state and limit. */
      list: async (storeId: string): Promise<{ data: StoreDomain[]; meta: DomainListMeta }> =>
        listOf<StoreDomain, DomainListMeta>(`${store(storeId)}/domains`, undefined, {
          cname_target: '',
          txt_prefix: '_storeplix-verify',
          can_add: false,
          feature_enabled: false,
          limit: { used: 0, max: 0 },
        }),
      /** 201 `pending_verification` with `dns_records` filled; the first check is queued. */
      add: (storeId: string, input: AddDomainInput) => request<StoreDomain>(`${store(storeId)}/domains`, { method: 'POST', body: { hostname: input.hostname } }),
      get: (storeId: string, id: string, opts?: Pick<RequestOptions, 'signal'>) => request<StoreDomain>(`${store(storeId)}/domains/${enc(id)}`, { signal: opts?.signal }),
      /** "Check now": a synchronous check; returns the updated row (provider/DNS errors come back as `failure_code`, never 502). */
      recheck: (storeId: string, id: string) => request<StoreDomain>(`${store(storeId)}/domains/${enc(id)}/verify`, { method: 'POST' }),
      /** Returns the whole list (old and new primary changed). */
      makePrimary: (storeId: string, id: string) => request<StoreDomain[]>(`${store(storeId)}/domains/${enc(id)}/primary`, { method: 'POST' }),
      /** 204; when it was the primary, the slug platform address becomes primary again. */
      remove: (storeId: string, id: string) => request<void>(`${store(storeId)}/domains/${enc(id)}`, { method: 'DELETE' }),
    },

    /**
     * Phase 7 §6.1 billing (tenant-level). Reads O A (`ViewBilling`); writes owner only (`ManageBilling`, 403 otherwise).
     * quote / changePlan → 409 `plan_unchanged` | `invoice_overdue`, 422 `plan_unavailable`. pay → 409 `invoice_not_open`,
     * 422 `billing_gateway_unavailable`, 502 `provider_unavailable`. `idempotencyKey` is created once per dialog open.
     */
    billing: {
      quote: (input: BillingQuoteInput) => request<BillingQuote>('/billing/quote', { method: 'POST', body: { plan_code: input.plan_code, interval: input.interval } }),
      /** new/upgrade → 201 with an open invoice; downgrade/cancel → 200 with `invoice: null` (scheduled). */
      changePlan: (input: BillingQuoteInput, idempotencyKey: string) =>
        request<ChangePlanResult>('/billing/change-plan', {
          method: 'POST',
          body: { plan_code: input.plan_code, interval: input.interval },
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      /** "Keep {plan}": drops a scheduled downgrade/cancel. 404 when nothing is scheduled. */
      cancelScheduledChange: () => request<Subscription>('/billing/scheduled-change', { method: 'DELETE' }),
      invoices: async (filters: { page?: number; per_page?: number; status?: BillingInvoiceStatus } = {}): Promise<{ data: BillingInvoiceSummary[]; meta: BillingInvoiceListMeta }> =>
        listOf<BillingInvoiceSummary, BillingInvoiceListMeta>(
          '/billing/invoices',
          { page: filters.page, per_page: filters.per_page, 'filter[status]': filters.status },
          { ...emptyPage(), providers: [] },
        ),
      invoice: (id: string) => request<BillingInvoice>(`/billing/invoices/${enc(id)}`),
      invoicePdf: (id: string, number?: string) => requestBlob(`/billing/invoices/${enc(id)}/pdf`, { fallbackName: `${number ?? 'invoice'}.pdf` }),
      /** 201 pending payment with `redirect_url`; the same key returns the same payment. */
      pay: (invoiceId: string, input: PayInvoiceInput, idempotencyKey: string) =>
        request<BillingPayment>(`/billing/invoices/${enc(invoiceId)}/pay`, {
          method: 'POST',
          body: { provider: input.provider },
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      payment: (id: string, opts?: Pick<RequestOptions, 'signal'>) => request<BillingPayment>(`/billing/payments/${enc(id)}`, { signal: opts?.signal }),
    },

    /**
     * PHASE-8-4 §6.1 API keys (tenant-level, `developers.manage`). Writes: 402 `feature_not_in_plan` (Growth),
     * 422 `scope_not_grantable` (details.scopes) / `limit_reached` (10 active keys) / `validation_failed`.
     */
    apiKeys: {
      /** Active first, then revoked of the last 90 days. */
      list: () => request<ApiKey[]>('/api-keys'),
      /** 201; `plain_key` is returned only here — show it once. */
      create: (input: CreateApiKeyInput) => request<ApiKeyCreated>('/api-keys', { method: 'POST', body: input }),
      rename: (keyId: string, input: UpdateApiKeyInput) =>
        request<ApiKey>(`/api-keys/${enc(keyId)}`, { method: 'PATCH', body: { name: input.name } }),
      /** Idempotent; the row is kept with `status: 'revoked'`. */
      revoke: (keyId: string) => request<ApiKey>(`/api-keys/${enc(keyId)}`, { method: 'DELETE' }),
      /** Scope catalogue with `grantable` for the signed-in actor. */
      scopes: () => request<ApiScopeInfo[]>('/api-scopes'),
    },

    /**
     * PHASE-8-4 §6.1 outbound webhooks (store-scoped, `developers.manage`). Writes: 402 `feature_not_in_plan`;
     * endpoints → 422 `webhook_url_not_allowed` / `limit_reached` (5 per store); reveal is throttled 10/min (429).
     */
    webhooks: {
      eventTypes: () => request<WebhookEventTypeInfo[]>('/webhook-event-types'),
      endpoints: {
        list: (storeId: string) => request<WebhookEndpoint[]>(`${store(storeId)}/webhook-endpoints`),
        create: (storeId: string, input: CreateWebhookEndpointInput) =>
          request<WebhookEndpoint>(`${store(storeId)}/webhook-endpoints`, { method: 'POST', body: input }),
        /** Partial; `is_active: false` disables (`disabled_reason: 'manual'`), `true` re-enables. */
        update: (storeId: string, endpointId: string, input: UpdateWebhookEndpointInput) =>
          request<WebhookEndpoint>(`${store(storeId)}/webhook-endpoints/${enc(endpointId)}`, { method: 'PATCH', body: input }),
        /** Hard delete; its deliveries go with it. */
        remove: (storeId: string, endpointId: string) =>
          request<void>(`${store(storeId)}/webhook-endpoints/${enc(endpointId)}`, { method: 'DELETE' }),
        /** Sends a `ping` now → 202 with the new delivery. */
        test: (storeId: string, endpointId: string) =>
          request<WebhookDelivery>(`${store(storeId)}/webhook-endpoints/${enc(endpointId)}/test`, { method: 'POST' }),
      },
      secret: {
        get: (storeId: string) => request<WebhookSecret>(`${store(storeId)}/webhook-secret`),
        /** Audited; 429 beyond 10/min. */
        reveal: (storeId: string) => request<WebhookSecretRevealed>(`${store(storeId)}/webhook-secret/reveal`, { method: 'POST' }),
        /** Returns the NEW secret once; the previous one keeps signing for 24 h (`previous_expires_at`). */
        rotate: (storeId: string) => request<WebhookSecretRevealed>(`${store(storeId)}/webhook-secret/rotate`, { method: 'POST' }),
      },
      deliveries: {
        /** Newest first, cursor pages of 25, without payload. */
        list: (storeId: string, filters: WebhookDeliveryFilters = {}) =>
          listOf<WebhookDelivery, CursorMeta>(
            `${store(storeId)}/webhook-deliveries`,
            {
              'filter[endpoint_id]': filters.endpoint_id || undefined,
              'filter[status]': filters.status,
              'filter[event_type]': filters.event_type,
              cursor: filters.cursor || undefined,
            },
            { next_cursor: null, prev_cursor: null, per_page: 25 },
          ),
        get: (storeId: string, deliveryId: string) =>
          request<WebhookDeliveryDetail>(`${store(storeId)}/webhook-deliveries/${enc(deliveryId)}`),
        /** 202: a new delivery row with the stored payload (same event id). */
        resend: (storeId: string, deliveryId: string) =>
          request<WebhookDelivery>(`${store(storeId)}/webhook-deliveries/${enc(deliveryId)}/resend`, { method: 'POST' }),
        /** Failed deliveries of the last 24 h, max 100 per call. */
        resendFailed: (storeId: string) =>
          request<WebhookResendFailedResult>(`${store(storeId)}/webhook-deliveries/resend-failed`, { method: 'POST' }),
      },
    },

    /** PHASE-8-5 §6.1 Marketing overview (`marketing.manage`). */
    marketing: {
      overview: (storeId: string, range: MarketingRange = '30d') =>
        request<MarketingOverview>(`${store(storeId)}/marketing/overview`, { query: { range } }),
    },

    /**
     * PHASE-8-5 §6.1 campaigns (store-scoped, `marketing.manage`). Writes: 409 `store_not_live` (draft/suspended store),
     * 422 `limit_reached` (50 non-terminal), `campaign_unknown_merge_field` / `campaign_too_long` /
     * `campaign_coupon_inactive` / `validation_failed`. Schedule/send: 402 `plan_limit_reached`, 422 `campaign_quiet_hours` /
     * `campaign_no_recipients`, `Idempotency-Key` required (create once per confirm dialog, reuse on retry).
     */
    campaigns: {
      list: (storeId: string, filters: CampaignListFilters = {}) =>
        listOf<CampaignListItem, PaginationMeta>(
          `${store(storeId)}/campaigns`,
          {
            'filter[status]': filters.status?.length ? filters.status.join(',') : undefined,
            'filter[channel]': filters.channel,
            q: filters.q?.trim() || undefined,
            sort: filters.sort,
            page: filters.page,
            per_page: filters.per_page,
          },
          emptyPage(),
        ),
      get: (storeId: string, id: string) => request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}`),
      /** 201 `draft`. */
      create: (storeId: string, input: CreateCampaignInput) => request<Campaign>(`${store(storeId)}/campaigns`, { method: 'POST', body: input }),
      /** `draft` / `scheduled` only; needs `revision` (409 `revision_conflict`). */
      update: (storeId: string, id: string, input: UpdateCampaignInput) =>
        request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}`, { method: 'PATCH', body: input }),
      /** `draft` only (hard delete), else 409 `invalid_state_transition`. */
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/campaigns/${enc(id)}`, { method: 'DELETE' }),
      /** §3.3; throttled 30/min per user (429). */
      audiencePreview: (storeId: string, input: AudiencePreviewInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<AudiencePreview>(`${store(storeId)}/campaigns/audience-preview`, { method: 'POST', body: input, signal: opts?.signal }),
      estimate: (storeId: string, input: CampaignEstimateInput, opts?: Pick<RequestOptions, 'signal'>) =>
        request<CampaignEstimate>(`${store(storeId)}/campaigns/estimate`, { method: 'POST', body: input, signal: opts?.signal }),
      /** P85-26 "Send test to me" → 202; 5/hour per user (429); counts toward the allowance (402). */
      sendTest: (storeId: string, id: string) =>
        request<CampaignTestResult>(`${store(storeId)}/campaigns/${enc(id)}/test`, { method: 'POST' }),
      schedule: (storeId: string, id: string, input: ScheduleCampaignInput, idempotencyKey: string) =>
        request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}/schedule`, {
          method: 'POST',
          body: input,
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      /** Send now → 202 with the campaign in `sending`. */
      send: (storeId: string, id: string, idempotencyKey: string) =>
        request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}/send`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }),
      /** `scheduled → draft`. */
      unschedule: (storeId: string, id: string) => request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}/unschedule`, { method: 'POST' }),
      /** `draft|scheduled|sending → cancelled`; already-sent recipients stay sent. */
      cancel: (storeId: string, id: string) => request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}/cancel`, { method: 'POST' }),
      /** 201 new draft "{name} (copy)". */
      duplicate: (storeId: string, id: string) => request<Campaign>(`${store(storeId)}/campaigns/${enc(id)}/duplicate`, { method: 'POST' }),
      /** Needs `marketing.manage` AND `customers.view`; cursor pages of 50; addresses masked. */
      recipients: (storeId: string, id: string, filters: CampaignRecipientFilters = {}) =>
        listOf<CampaignRecipient, CursorMeta>(
          `${store(storeId)}/campaigns/${enc(id)}/recipients`,
          {
            'filter[status]': filters.status?.length ? filters.status.join(',') : undefined,
            'filter[skip_reason]': filters.skip_reason?.length ? filters.skip_reason.join(',') : undefined,
            cursor: filters.cursor || undefined,
          },
          { next_cursor: null, prev_cursor: null, per_page: 50 },
        ),
      /** §5.4 dev message sink (non-production with `CAMPAIGNS_DEV_SINK=true`; 404 otherwise). Newest first. */
      devSink: (storeId: string) => request<DevSinkMessage[]>(`/dev${store(storeId)}/message-sink`),
    },

    /**
     * PHASE-8-6 §9.1 automations (store-scoped, `marketing.manage`; staff 403). Plan without `sms_automation` → 402
     * `feature_not_in_plan` on create / enable / PATCH of an `on` automation / test message.
     */
    automations: {
      /** `meta.recipes` = the catalogue (incl. `added`), `meta.kpis` = page tiles. */
      list: (storeId: string) =>
        listOf<Automation, AutomationListMeta>(`${store(storeId)}/automations`, undefined, {
          recipes: [],
          kpis: {
            active: 0, drafts: 0, total: 0, runs_7d: 0, runs_7d_succeeded_pct: null, messages_sent_month: 0,
            carts_recovered_30d: 0, recovered_revenue_30d: 0,
          },
        }),
      get: (storeId: string, id: string) => request<AutomationDetail>(`${store(storeId)}/automations/${enc(id)}`),
      /** 201 `draft` with the recipe defaults; 409 `automation_exists`. */
      create: (storeId: string, input: CreateAutomationInput) =>
        request<AutomationDetail>(`${store(storeId)}/automations`, { method: 'POST', body: input }),
      /** `settings` replaces the whole object (validated per recipe); 409 `revision_conflict`. */
      update: <R extends RecipeKey = RecipeKey>(storeId: string, id: string, input: UpdateAutomationInput<R>) =>
        request<AutomationDetail>(`${store(storeId)}/automations/${enc(id)}`, { method: 'PATCH', body: input }),
      /** `draft|off → on`; 422 `automation_incomplete` (`details.fields`). */
      enable: (storeId: string, id: string) =>
        request<AutomationDetail>(`${store(storeId)}/automations/${enc(id)}/enable`, { method: 'POST' }),
      /** `on → off`; waiting runs end `stopped/automation_off`. */
      disable: (storeId: string, id: string) =>
        request<AutomationDetail>(`${store(storeId)}/automations/${enc(id)}/disable`, { method: 'POST' }),
      /** `draft` only, else 409 `automation_not_draft`. */
      delete: (storeId: string, id: string) => request<void>(`${store(storeId)}/automations/${enc(id)}`, { method: 'DELETE' }),
      /** P86-21: no side effects; 30/min per user (429). Pass at most one subject id. */
      dryRun: (storeId: string, id: string, input: AutomationDryRunInput = {}, opts?: Pick<RequestOptions, 'signal'>) =>
        request<AutomationDryRun>(`${store(storeId)}/automations/${enc(id)}/dry-run`, { method: 'POST', body: input, signal: opts?.signal }),
      /** P86-22 → 202; 5/hour per user (429); counts toward the allowance (402 `plan_limit_reached`). */
      testMessage: (storeId: string, id: string, step: 1 | 2 = 1) =>
        request<AutomationTestResult>(`${store(storeId)}/automations/${enc(id)}/test-message`, { method: 'POST', body: { step } }),
      stats: (storeId: string, id: string, days: AutomationStatsDays = 14) =>
        request<AutomationStats>(`${store(storeId)}/automations/${enc(id)}/stats`, { query: { days } }),
      /** Run log: cursor pages of 50, newest first; addresses masked. */
      runs: (storeId: string, filters: AutomationRunFilters = {}) =>
        listOf<AutomationRun, CursorMeta>(
          `${store(storeId)}/automation-runs`,
          {
            'filter[automation_id]': filters.automation_id || undefined,
            'filter[recipe]': filters.recipe,
            'filter[status]': filters.status?.length ? filters.status.join(',') : undefined,
            'filter[since]': filters.since || undefined,
            cursor: filters.cursor || undefined,
          },
          { next_cursor: null, prev_cursor: null, per_page: 50 },
        ),
      run: (storeId: string, runId: string) => request<AutomationRun>(`${store(storeId)}/automation-runs/${enc(runId)}`),
    },

    /** Phase 7 §6.3 reports (store-scoped). Profit → 402 `feature_not_in_plan` (non-Growth), 403 for staff. */
    reports: {
      sales: (storeId: string, range: ReportRangeQuery = {}) => report<SalesReport>(storeId, 'sales', range),
      profit: (storeId: string, range: ReportRangeQuery = {}) => report<ProfitReport>(storeId, 'profit', range),
      delivery: (storeId: string, range: ReportRangeQuery = {}) => report<DeliveryReport>(storeId, 'delivery', range),
    },

    /** Phase 5a §3.8 go-live. Publish → 409 `launch_blocked` with `details.<item_key>`. */
    launch: {
      checklist: (storeId: string) => request<LaunchChecklist>(`${store(storeId)}/launch-checklist`),
      publish: (storeId: string) => request<Store>(`${store(storeId)}/publish`, { method: 'POST' }),
    },

    dashboard: {
      get: (storeId: string) => request<DashboardSummary>(`${store(storeId)}/dashboard`),
    },

    storefront: {
      /**
       * Server-to-server only (Next.js storefront). Never call from a browser — `key` is a secret.
       * Throws ApiError with code `store_not_found` (404) for unknown hosts. A suspended shop answers `StorefrontSuspended`
       * (check with `isStorefrontSuspended` from @storeplix/types).
       */
      getConfig: (host: string, key: string, opts?: Pick<RequestOptions, 'init' | 'signal'> & { previewToken?: string | null }) =>
        request<StorefrontConfigResponse>('/storefront/config', {
          init: opts?.init,
          signal: opts?.signal,
          anonymous: true,
          headers: {
            'X-Storefront-Host': normalizeHost(host),
            'X-Storefront-Key': key,
            ...(opts?.previewToken ? { 'X-Storefront-Preview': opts.previewToken } : {}),
          },
        }),
      /**
       * PHASE-8-5 §4.2 unsubscribe (server-to-server only). GET never changes state. Unknown or malformed code →
       * 404 `unsubscribe_link_invalid`; 20/min per shopper IP (429). `clientIp` → `X-Storefront-Client-Ip`.
       */
      unsubscribe: {
        get: (host: string, key: string, code: string, opts?: { clientIp?: string | null; signal?: AbortSignal }) =>
          request<UnsubscribeStatus>(`/storefront/unsubscribe/${enc(code)}`, {
            anonymous: true,
            signal: opts?.signal,
            init: { cache: 'no-store' },
            headers: storefrontHeaders(host, key, opts?.clientIp),
          }),
        /** Idempotent; a test code answers 200 with `is_test: true` and changes nothing. */
        post: (host: string, key: string, code: string, input: UnsubscribeInput, opts?: { clientIp?: string | null; signal?: AbortSignal }) =>
          request<UnsubscribeStatus>(`/storefront/unsubscribe/${enc(code)}`, {
            method: 'POST',
            body: input,
            anonymous: true,
            signal: opts?.signal,
            init: { cache: 'no-store' },
            headers: storefrontHeaders(host, key, opts?.clientIp),
          }),
      },
      /**
       * PHASE-8-6 §7 checkout contact (server-to-server only) → 204. Fire-and-forget from the checkout form: never block
       * checkout on its failure. 404 `cart_not_found` (no/empty cart), 422 invalid phone, 10/min per shopper IP (429).
       */
      saveCartContact: (host: string, key: string, cartToken: string, input: CartContactInput, opts?: { clientIp?: string | null; signal?: AbortSignal }) =>
        request<void>('/storefront/cart/contact', {
          method: 'PUT',
          body: input,
          anonymous: true,
          signal: opts?.signal,
          init: { cache: 'no-store' },
          headers: { ...storefrontHeaders(host, key, opts?.clientIp), 'X-Cart-Token': cartToken },
        }),
      /**
       * P86-16 restore a cart from a recovery link code → 201 with a **new** cart token (set it as `sp_cart`). Invalid,
       * stopped or expired → 404 `recovery_link_invalid`; 20/min per shopper IP (429).
       */
      recoverCart: (host: string, key: string, code: string, opts?: { clientIp?: string | null; signal?: AbortSignal }) =>
        request<RecoverCartResult>('/storefront/carts/recover', {
          method: 'POST',
          body: { code },
          anonymous: true,
          signal: opts?.signal,
          init: { cache: 'no-store' },
          headers: storefrontHeaders(host, key, opts?.clientIp),
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function storefrontHeaders(host: string, key: string, clientIp?: string | null): Record<string, string> {
  return {
    'X-Storefront-Host': normalizeHost(host),
    'X-Storefront-Key': key,
    ...(clientIp ? { 'X-Storefront-Client-Ip': clientIp } : {}),
  };
}

/** Lowercase, strip port and trailing dot. `Demo.LocalHost:3000` → `demo.localhost`. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}
