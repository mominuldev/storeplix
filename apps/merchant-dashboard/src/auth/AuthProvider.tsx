import type { LoginInput, MeResponse, RegisterInput } from '@storeplix/api-client';
import type { AuthSession, MeImpersonation, TenantMembership } from '@storeplix/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { expireSession, impersonation } from '../impersonation/store';
import { suspension } from '../impersonation/suspension';
import { api } from '../lib/api';
import { session } from '../lib/session';

type AuthStatus = 'anonymous' | 'loading' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: MeResponse | null;
  tenants: TenantMembership[];
  tenantId: string | null;
  activeTenant: TenantMembership | null;
  setTenant: (id: string) => void;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  /** Adopt a session started elsewhere (OTP login, invitation accept, password change). */
  /** Phase 8.1: `impersonation` = a read-only support session started from an admin ticket (tenant from the row). */
  startSession: (auth: AuthSession, opts?: { keepTenant?: boolean; impersonation?: MeImpersonation }) => void;
  /** Re-fetch /auth/me (after profile, phone or membership changes). */
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const MAX_TIMEOUT = 2 ** 31 - 1;
/** Set from "Open this shop by default next time" on Choose a shop (L4). */
export const DEFAULT_TENANT_KEY = 'storeplix.merchant.default-tenant';

function rememberDefaultTenant(): boolean {
  try {
    return localStorage.getItem(DEFAULT_TENANT_KEY) === '1';
  } catch {
    return false;
  }
}

/** One membership → select it; several → keep a valid stored choice, else let Choose a shop decide. */
function adoptTenants(user: MeResponse) {
  const tenants = user.tenants ?? [];
  const stored = session.getTenantId();
  if (!tenants.some((t) => t.id === stored)) session.setTenantId(tenants.length === 1 ? tenants[0]!.id : null);
}

/**
 * Phase 4.7b (contract §7.3): the session is an HttpOnly same-origin cookie. Boot = GET /auth/me (200 signed in,
 * 401 signed out); `meta.session_expires_at` drives the proactive logout timer. No token is kept in JS.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const epoch = useSyncExternalStore(session.subscribe, session.getEpoch, () => 0);
  const tenantId = useSyncExternalStore(session.subscribe, session.getTenantId, () => null);
  const expiresAt = useSyncExternalStore(session.subscribe, session.getExpiresAt, () => null);
  const meKey = useMemo(() => ['auth', 'me', epoch] as const, [epoch]);

  // XSRF-TOKEN cookie on boot (writes also fetch it lazily).
  useEffect(() => {
    void api.ensureCsrf().catch(() => undefined);
  }, []);

  const me = useQuery({
    queryKey: meKey,
    queryFn: async () => {
      const { user, session_expires_at, impersonation: imp } = await api.auth.sessionInfo();
      // Phase 8.1: an impersonation session sees exactly the impersonated tenant (P8-10).
      impersonation.set(imp);
      if (imp) session.setTenantId(imp.tenant_id);
      // Past the absolute expiry (clock skew, stale tab): treat as signed out instead of looping.
      if (session_expires_at && Date.parse(session_expires_at) <= Date.now()) {
        expireSession();
        throw new Error('session_expired');
      }
      // Persist a valid tenant before any tenant-scoped query runs (X-Tenant-Id is read from the session store).
      adoptTenants(user);
      session.start({ expires_at: session_expires_at ?? session.getExpiresAt() });
      return user;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Proactive logout when the absolute expiry passes (contract D3 / §7.2).
  useEffect(() => {
    if (!expiresAt) return;
    const ms = session.msUntilExpiry();
    if (ms === null) return;
    if (ms <= 0) {
      expireSession();
      return;
    }
    const id = setTimeout(expireSession, Math.min(ms, MAX_TIMEOUT));
    return () => clearTimeout(id);
  }, [expiresAt]);

  // Drop cached tenant data whenever a session ends (epoch bumps on clear/expire).
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'health' && q.queryKey[0] !== 'auth' });
  }, [epoch, queryClient]);

  const tenants = useMemo(() => me.data?.tenants ?? [], [me.data]);

  const setTenant = useCallback(
    (id: string) => {
      session.setTenantId(id);
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    },
    [queryClient],
  );

  const startSession = useCallback(
    (auth: AuthSession, opts?: { keepTenant?: boolean; impersonation?: MeImpersonation }) => {
      suspension.reset();
      if (opts?.impersonation) {
        // The session was replaced by the staff user's read-only session: drop every cached tenant query.
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'health' && q.queryKey[0] !== 'auth' });
        impersonation.begin(opts.impersonation);
        session.setTenantId(opts.impersonation.tenant_id);
      } else {
        impersonation.reset();
        // Fresh sign-in: unless the user asked to reopen the same shop, post-login routing asks again
        // when they belong to several shops (contract D1).
        if (!opts?.keepTenant && !rememberDefaultTenant()) session.setTenantId(null);
      }
      adoptTenants(auth.user);
      session.start({ expires_at: auth.expires_at });
      queryClient.setQueryData(['auth', 'me', session.getEpoch()], auth.user);
      // The session id was regenerated on login: make sure the next write has a fresh XSRF-TOKEN.
      void api.ensureCsrf(true).catch(() => undefined);
    },
    [queryClient],
  );

  const login = useCallback(async (input: LoginInput) => startSession(await api.auth.login(input)), [startSession]);
  const register = useCallback(async (input: RegisterInput) => startSession(await api.auth.register(input)), [startSession]);

  const refetchMe = me.refetch;
  const refreshUser = useCallback(async () => {
    await refetchMe();
  }, [refetchMe]);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* session may already be gone — clear locally regardless */
    }
    impersonation.reset();
    suspension.reset();
    session.clear();
    session.consumeNotice();
    queryClient.clear();
    // Logout rotated the CSRF token.
    void api.ensureCsrf(true).catch(() => undefined);
  }, [queryClient]);

  const status: AuthStatus = me.data ? 'authenticated' : me.isError ? 'anonymous' : 'loading';

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: me.data ?? null,
      tenants,
      tenantId,
      activeTenant: tenants.find((t) => t.id === tenantId) ?? null,
      setTenant,
      login,
      register,
      startSession,
      refreshUser,
      logout,
    }),
    [status, me.data, tenants, tenantId, setTenant, login, register, startSession, refreshUser, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
