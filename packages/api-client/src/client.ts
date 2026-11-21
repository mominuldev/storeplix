import type {
  ApiSuccess,
  AuthToken,
  HealthStatus,
  PaginationMeta,
  PreviewToken,
  Store,
  StorefrontConfig,

} from '@storeplix/types';
import { ApiError, isErrorEnvelope } from './errors';
import type {
  CreateStoreInput,
  ForgotPasswordInput,
  LoginInput,
  MeResponse,
  RegisterInput,
} from './models';

export interface ApiClientOptions {
  /** API origin, e.g. `http://localhost:8000`. `/api/v1` is appended automatically. */
  baseUrl: string;
  /** Returns the current Bearer token (merchant/admin SPA). */
  getToken?: () => string | null | undefined;
  /** Returns the active tenant ULID, sent as `X-Tenant-Id`. */
  getTenantId?: () => string | null | undefined;
  /** Custom fetch (tests, Next.js `fetch` with cache options). Defaults to global fetch. */
  fetch?: typeof fetch;
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
  /** Override the X-Tenant-Id for this call (e.g. listing each membership's store). */
  tenantId?: string;
  /** Passed through to fetch (Next.js uses `next`/`cache`). */
  init?: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } };
}

export interface Paginated<T> {
  data: T;
  meta?: PaginationMeta | Record<string, unknown>;
}

const API_PREFIX = '/api/v1';

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

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

  /** Low-level call returning the full envelope `{ data, meta? }`. */
  async function requestEnvelope<T>(path: string, opts: RequestOptions = {}): Promise<ApiSuccess<T> | undefined> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!opts.anonymous) {
      const token = options.getToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
      const tenantId = opts.tenantId ?? options.getTenantId?.();
      if (tenantId) headers['X-Tenant-Id'] = tenantId;
    }

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

    if (response.status === 204) return undefined;

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!response.ok) {
      const error = isErrorEnvelope(body)
        ? new ApiError(response.status, body.error.code, body.error.message, body.error.details)
        : new ApiError(response.status, 'http_error', response.statusText || `Request failed (${response.status})`);
      if (error.status === 401) options.onUnauthorized?.(error);
      throw error;
    }

    // e.g. 202 Accepted with no body
    if (!text) return undefined;
    if (typeof body !== 'object' || body === null || !('data' in body)) {
      throw new ApiError(response.status, 'invalid_response', 'Unexpected response from the server.');
    }
    return body as ApiSuccess<T>;
  }

  /** Call an endpoint and unwrap `data`. Resolves `undefined` for 204. */
  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const envelope = await requestEnvelope<T>(path, opts);
    return envelope?.data as T;
  }

  return {
    request,
    requestEnvelope,

    health: (opts?: RequestOptions) => request<HealthStatus>('/health', { anonymous: true, ...opts }),

    auth: {
      register: (input: RegisterInput) =>
        request<AuthToken>('/auth/register', { method: 'POST', body: input, anonymous: true }),
      login: (input: LoginInput) =>
        request<AuthToken>('/auth/login', { method: 'POST', body: input, anonymous: true }),
      logout: () => request<void>('/auth/logout', { method: 'POST' }),
      /** `User` including `tenants` memberships. */
      me: () => request<MeResponse>('/auth/me'),
      /** Always resolves (API returns 202 whether or not the email exists). */
      forgotPassword: (input: ForgotPasswordInput) =>
        request<void>('/auth/forgot-password', { method: 'POST', body: input, anonymous: true }),
    },

    stores: {
      /** Tenant-scoped (X-Tenant-Id). Contract D1: a tenant has at most one store. */
      list: async (query?: { page?: number; per_page?: number }, opts?: { tenantId?: string }): Promise<Paginated<Store[]>> => {
        const envelope = await requestEnvelope<Store[]>('/stores', { query, tenantId: opts?.tenantId });
        return { data: envelope?.data ?? [], meta: envelope?.meta };
      },
      /** 409 `store_limit_reached` when the tenant already has its store. */
      create: (input: CreateStoreInput) => request<Store>('/stores', { method: 'POST', body: input }),
      /** Short-lived signed link to preview a draft store (opens `url` in a new tab). */
      createPreviewToken: (storeId: string) =>
        request<PreviewToken>(`/stores/${encodeURIComponent(storeId)}/preview-token`, { method: 'POST' }),
    },

    storefront: {
      /**
       * Server-to-server only (Next.js storefront). Never call from a browser — `key` is a secret.
       * Throws ApiError with code `store_not_found` (404) for unknown hosts.
       */
      getConfig: (
        host: string,
        key: string,
        opts?: Pick<RequestOptions, 'init' | 'signal'> & { previewToken?: string | null },
      ) =>
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
