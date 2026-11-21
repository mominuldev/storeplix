import type { LoginInput, MeResponse } from '@storeplix/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../lib/api';
import { session } from '../lib/session';

type AuthStatus = 'anonymous' | 'loading' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: MeResponse | null;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Platform staff session. Phase 1 reuses /auth/login; a platform-admin role check is pending in the API contract.
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const token = useSyncExternalStore(session.subscribe, session.getToken, () => null);

  const me = useQuery({
    queryKey: ['auth', 'me', token],
    queryFn: () => api.auth.me(),
    enabled: !!token,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const login = useCallback(async (input: LoginInput) => {
    const { token: newToken } = await api.auth.login(input);
    session.setToken(newToken);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* already invalid */
    }
    session.clear();
    queryClient.clear();
  }, [queryClient]);

  const status: AuthStatus = !token ? 'anonymous' : me.data ? 'authenticated' : me.isError ? 'anonymous' : 'loading';
  const value = useMemo(() => ({ status, user: me.data ?? null, login, logout }), [status, me.data, login, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
