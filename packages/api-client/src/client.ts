import type {
  AcceptInvitationInput,
  ApiSuccess,
  AuditLog,
  AuditLogFilters,
  AuthToken,
  ChangePasswordInput,
  CreatePageInput,
  CreateStoreInput,
  FeatureAccess,
  ForgotPasswordInput,
  HealthStatus,
  InvitationPreview,
  InviteStaffInput,
  LoginInput,
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
  StorefrontConfig,
  StoreSettings,
  Subscription,
  TenantMembership,
  UpdateProfileInput,
  UpdateStaffRoleInput,
  UpdateStoreSettingsInput,
} from '@storeplix/types';
import { ApiError, isErrorEnvelope } from './errors';
import type { MeResponse } from './models';

export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:8000`. `/api/v1` is appended automatically. */
  baseUrl: string;
  /** Returns the current Bearer token (merchant/admin SPA). */
  getToken?: () => string | null | undefined;
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
  /** Skip Authorization / X-Tenant-Id (public or server-to-server endpoints). */
  anonymous?: boolean;
  /** Send Authorization but no X-Tenant-Id (account-level endpoints, invitation accept). */
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
    'filter[subject_type]': f.subject_type,
    'filter[subject_id]': f.subject_id,
    'filter[created_at][gte]': f.created_from,
    'filter[created_at][lte]': f.created_to,
    page: f.page,
    per_page: f.per_page,
  };
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const makeXhr = options.xhr ?? (typeof XMLHttpRequest !== 'undefined' ? () => new XMLHttpRequest() : undefined);

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

  function authHeaders(opts: Pick<RequestOptions, 'anonymous' | 'noTenant' | 'tenantId'>): Record<string, string> {
    const headers: Record<string, string> = {};
    if (opts.anonymous) return headers;
    const token = options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!opts.noTenant) {
      const tenantId = opts.tenantId ?? options.getTenantId?.();
      if (tenantId) headers['X-Tenant-Id'] = tenantId;
    }
    return headers;
  }

  function handleError(error: unknown): never {
    if (error instanceof ApiError && error.status === 401) options.onUnauthorized?.(error);
    throw error;
  }

  /** Low-level call returning the full envelope `{ data, meta? }`. */
  async function requestEnvelope<T>(path: string, opts: RequestOptions = {}): Promise<ApiSuccess<T> | undefined> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      ...opts.headers,
      ...authHeaders(opts),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(buildUrl(path, opts.query), {
        ...opts.init,
        method: opts.method ?? 'GET',
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
      return handleError(error);
    }
  }

  /** Call an endpoint and unwrap `data`. Resolves `undefined` for 202/204 without a body. */
  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const envelope = await requestEnvelope<T>(path, opts);
    return envelope?.data as T;
  }

  /** Multipart upload with progress (XHR); falls back to fetch without progress. */
  function uploadMedia(input: UploadMediaInput, opts: UploadOptions = {}): Promise<Media> {
    const form = new FormData();
    const name = input.filename ?? (input.file instanceof File ? input.file.name : 'upload');
    form.append('file', input.file, name);
    form.append('purpose', input.purpose);
    if (input.alt) form.append('alt', input.alt);
    const url = buildUrl('/media');
    const headers = { Accept: 'application/json', ...options.headers, ...authHeaders({}) };

    if (!makeXhr) {
      return doFetch(url, { method: 'POST', headers, body: form, signal: opts.signal })
        .catch(() => {
          throw new ApiError(0, 'network_error', 'Unable to reach the server. Check your connection.');
        })
        .then(async (res) => parseResponse<Media>(res.status, res.statusText, await res.text())!.data)
        .catch(handleError);
    }

    return new Promise<Media>((resolve, reject) => {
      const xhr = makeXhr();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        try {
          const envelope = parseResponse<Media>(xhr.status, xhr.statusText, xhr.responseText);
          opts.onProgress?.(1);
          resolve(envelope!.data);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) options.onUnauthorized?.(error);
          reject(error);
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Upload failed. Check your connection.'));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    request,
    requestEnvelope,

    health: (opts?: RequestOptions) => request<HealthStatus>('/health', { anonymous: true, ...opts }),

    auth: {
      register: (input: RegisterInput) => request<AuthToken>('/auth/register', { method: 'POST', body: input, anonymous: true }),
      login: (input: LoginInput) => request<AuthToken>('/auth/login', { method: 'POST', body: input, anonymous: true }),
      logout: () => request<void>('/auth/logout', { method: 'POST', noTenant: true }),
      /** `User` including `tenants` memberships. */
      me: () => request<MeResponse>('/auth/me', { noTenant: true }),
      updateProfile: (input: UpdateProfileInput) => request<MeResponse>('/auth/me', { method: 'PATCH', body: input, noTenant: true }),
      /** Returns a NEW token; every other token (incl. the current one) is revoked. */
      changePassword: (input: ChangePasswordInput) => request<AuthToken>('/auth/password', { method: 'PUT', body: input, noTenant: true }),
      /** Always resolves (202) whether or not the email exists. */
      forgotPassword: (input: ForgotPasswordInput) =>
        request<MessageResponse | undefined>('/auth/forgot-password', { method: 'POST', body: input, anonymous: true }),
      /**
       * Addendum A. 202 `{expires_in, resend_in, dev_otp?}`. 429 `otp_rate_limited` → ApiError with
       * `retryAfter` (seconds). `dev_otp` only appears in local dev with the log SMS driver.
       */
      sendOtp: (input: SendOtpInput) =>
        // verify_phone needs Bearer; login/reset are public.
        request<SendOtpResponse>('/auth/otp/send', { method: 'POST', body: input, noTenant: true, anonymous: input.purpose !== 'verify_phone' }),
      verifyPhone: (input: VerifyPhoneInput) => request<User>('/auth/phone/verify', { method: 'POST', body: input, noTenant: true }),
      /** Same shape as password login. Wrong code → 422 `invalid_otp`. */
      loginWithOtp: (input: OtpLoginInput) => request<AuthToken>('/auth/login/otp', { method: 'POST', body: input, anonymous: true }),
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

    invitations: {
      preview: (token: string) => request<InvitationPreview>(`/invitations/${enc(token)}`, { anonymous: true }),
      /** New user: pass `input` → `AuthToken` (201). Signed-in existing user: omit → `TenantMembership` (200). */
      accept: ((token: string, input?: AcceptInvitationInput) =>
        input
          ? request<AuthToken>(`/invitations/${enc(token)}/accept`, { method: 'POST', body: input, anonymous: true })
          : request<TenantMembership>(`/invitations/${enc(token)}/accept`, { method: 'POST', noTenant: true })) as {
        (token: string, input: AcceptInvitationInput): Promise<AuthToken>;
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

    storefront: {
      /**
       * Server-to-server only (Next.js storefront). Never call from a browser — `key` is a secret.
       * Throws ApiError with code `store_not_found` (404) for unknown hosts.
       */
      getConfig: (host: string, key: string, opts?: Pick<RequestOptions, 'init' | 'signal'> & { previewToken?: string | null }) =>
        request<StorefrontConfig>('/storefront/config', {
          init: opts?.init,
          signal: opts?.signal,
          anonymous: true,
          headers: {
            'X-Storefront-Host': normalizeHost(host),
            'X-Storefront-Key': key,
            ...(opts?.previewToken ? { 'X-Storefront-Preview': opts.previewToken } : {}),
          },
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Lowercase, strip port and trailing dot. `Demo.LocalHost:3000` → `demo.localhost`. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}
