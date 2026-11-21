import type { LoginInput, MeResponse, RegisterInput, TenantMembership } from '@storeplix/api-client';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useSyncExternalStore(session.subscribe, session.getToken, () => null);
  const tenantId = useSyncExternalStore(session.subscribe, session.getTenantId, () => null);

  const me = useQuery({
    queryKey: ['auth', 'me', token],
    queryFn: () => api.auth.me(),
    enabled: !!token,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const tenants = useMemo(() => me.data?.tenants ?? [], [me.data]);

  // Keep the active tenant valid: default to the first membership.
  useEffect(() => {
    if (!tenants.length) return;
    if (!tenantId || !tenants.some((t) => t.id === tenantId)) session.setTenantId(tenants[0]!.id);
  }, [tenants, tenantId]);

  const setTenant = useCallback(
    (id: string) => {
      session.setTenantId(id);
      // Every tenant-scoped query must refetch under the new X-Tenant-Id.
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    },
    [queryClient],
  );

  const login = useCallback(async (input: LoginInput) => {
    const { token: newToken } = await api.auth.login(input);
    session.setToken(newToken);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const { token: newToken } = await api.auth.register(input);
    session.setToken(newToken);
  }, []);

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
