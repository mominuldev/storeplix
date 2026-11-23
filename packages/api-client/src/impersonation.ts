// Phase 8.1 merchant side of read-only impersonation (PHASE-8-1-CONTRACT §3.2, §6.6; ADR 0015) and the typed errors the
// merchant dashboard reacts to. The admin side (creating a ticket) lives in ./admin.ts.
import type { ApiSuccess, ImpersonationStart, MeImpersonation, MeMeta } from '@storeplix/types';
import type { RequestOptions } from './client';
import { ApiError } from './errors';
import type { MeResponse } from './models';

/** 401: the impersonation expired or was revoked; the session is gone. Show "Impersonation ended", not the login page. */
export const IMPERSONATION_ENDED = 'impersonation_ended';
/** 403: any write inside an impersonation session. */
export const IMPERSONATION_READ_ONLY = 'impersonation_read_only';
/** 403: the merchant's tenant is suspended (P8-12). */
export const TENANT_SUSPENDED = 'tenant_suspended';

type CodedError<C extends string> = ApiError & { readonly code: C };

export function isImpersonationEnded(error: unknown): error is CodedError<typeof IMPERSONATION_ENDED> {
  return error instanceof ApiError && error.status === 401 && error.code === IMPERSONATION_ENDED;
}

export function isImpersonationReadOnly(error: unknown): error is CodedError<typeof IMPERSONATION_READ_ONLY> {
  return error instanceof ApiError && error.status === 403 && error.code === IMPERSONATION_READ_ONLY;
}

export function isTenantSuspended(error: unknown): error is CodedError<typeof TENANT_SUSPENDED> {
  return error instanceof ApiError && error.status === 403 && error.code === TENANT_SUSPENDED;
}

/** `GET /auth/me` meta (openapi 1.9.0): `impersonation` is null (or absent on older APIs) outside impersonation. */
export interface MeSessionMeta extends MeMeta {
  impersonation?: MeImpersonation | null;
}

/** `/auth/me` unpacked: the user plus the session meta. */
export interface SessionInfo {
  user: MeResponse;
  session_expires_at: string | null;
  impersonation: MeImpersonation | null;
}

/** The transport primitives of `createApiClient` this namespace needs. */
export interface ImpersonationTransport {
  request<T>(path: string, opts?: RequestOptions): Promise<T>;
  requestEnvelope<T>(path: string, opts?: RequestOptions): Promise<ApiSuccess<T> | undefined>;
}

/** Spread into `auth`: `startImpersonation`, `endImpersonation`, `sessionInfo`. */
export function createImpersonationAuth(t: ImpersonationTransport) {
  return {
    /**
     * `POST /auth/impersonation {ticket}` (guest or any session, CSRF). Regenerates the session as the staff user in
     * read-only mode. Unknown, used or expired tickets → ApiError 404 `not_found`.
     */
    startImpersonation: (ticket: string) =>
      t.request<ImpersonationStart>('/auth/impersonation', { method: 'POST', body: { ticket }, anonymous: true }),
    /** `DELETE /auth/impersonation` → 204; ends the impersonation and logs out. */
    endImpersonation: () => t.request<void>('/auth/impersonation', { method: 'DELETE', noTenant: true }),
    /** `/auth/me` with `meta.session_expires_at` and `meta.impersonation`. 401 = signed out (or `impersonation_ended`). */
    sessionInfo: async (): Promise<SessionInfo> => {
      const envelope = await t.requestEnvelope<MeResponse>('/auth/me', { noTenant: true });
      if (!envelope) throw new ApiError(200, 'invalid_response', 'Unexpected response from the server.');
      const meta = (envelope.meta ?? {}) as Partial<MeSessionMeta>;
      return { user: envelope.data, session_expires_at: meta.session_expires_at ?? null, impersonation: meta.impersonation ?? null };
    },
  };
}
