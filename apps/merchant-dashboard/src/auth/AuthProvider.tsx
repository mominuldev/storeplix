import type { LoginInput, MeResponse, RegisterInput } from '@storeplix/api-client';
import type { AuthToken, TenantMembership } from '@storeplix/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
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

function startSession(auth: AuthToken) {
  // Fresh sign-in: unless the user asked to reopen the same shop, post-login routing asks again
  // when they belong to several shops (contract D1).
  if (!rememberDefaultTenant()) session.setTenantId(null);
  session.setAuth(auth);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useSyncExternalStore(session.subscribe, session.getToken, () => null);
  const tenantId = useSyncExternalStore(session.subscribe, session.getTenantId, () => null);

  const me = useQuery({
    queryKey: ['auth', 'me', token],
    queryFn: async () => {
      const user = await api.auth.me();
      // Persist a valid tenant before any tenant-scoped query runs (X-Tenant-Id is read from the session).
      // One membership → select it; several → keep a valid stored choice, else let Choose a shop decide.
      const tenants = user.tenants ?? [];
      const stored = session.getTenantId();
      if (!tenants.some((t) => t.id === stored)) session.setTenantId(tenants.length === 1 ? tenants[0]!.id : null);
      return user;
    },
    enabled: !!token,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Proactive logout when expires_at passes (contract D3).
  useEffect(() => {
    if (!token) return;
    const ms = session.msUntilExpiry();
    if (ms === null) return;
    if (ms <= 0) {
      session.expire();
      return;
    }
    const id = setTimeout(() => session.expire(), Math.min(ms, MAX_TIMEOUT));
    return () => clearTimeout(id);
  }, [token]);

  // Drop cached tenant data whenever the session ends.
  useEffect(() => {
    if (!token) queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'health' });
  }, [token, queryClient]);

  const tenants = useMemo(() => me.data?.tenants ?? [], [me.data]);

  const setTenant = useCallback(
    (id: string) => {
      session.setTenantId(id);
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    },
    [queryClient],
  );

  const login = useCallback(async (input: LoginInput) => startSession(await api.auth.login(input)), []);
  const register = useCallback(async (input: RegisterInput) => startSession(await api.auth.register(input)), []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* token may already be invalid — clear locally regardless */
    }
    session.clear();
    queryClient.clear();
  }, [queryClient]);

  const status: AuthStatus = !token ? 'anonymous' : me.data ? 'authenticated' : me.isError ? 'anonymous' : 'loading';

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
      logout,
    }),
    [status, me.data, tenants, tenantId, setTenant, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
