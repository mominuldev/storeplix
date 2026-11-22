import type { LoginInput, MeResponse } from '@storeplix/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
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
// Phase 4.7b: HttpOnly same-origin cookie session; boot = GET /auth/me (200 signed in, 401 signed out).
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const epoch = useSyncExternalStore(session.subscribe, session.getEpoch, () => 0);
  const expiresAt = useSyncExternalStore(session.subscribe, session.getExpiresAt, () => null);

  useEffect(() => {
    void api.ensureCsrf().catch(() => undefined);
  }, []);

  const me = useQuery({
    queryKey: ['auth', 'me', epoch],
    queryFn: async () => {
      const { user, session_expires_at } = await api.auth.session();
      // Past the absolute expiry (clock skew, stale tab): treat as signed out instead of looping.
      if (session_expires_at && Date.parse(session_expires_at) <= Date.now()) {
        session.expire();
        throw new Error('session_expired');
      }
      session.start({ expires_at: session_expires_at ?? session.getExpiresAt() });
      return user;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Proactive logout when the absolute expiry passes (contract D3).
  useEffect(() => {
    if (!expiresAt) return;
    const ms = session.msUntilExpiry();
    if (ms === null) return;
    if (ms <= 0) {
      session.expire();
      return;
    }
    const id = setTimeout(() => session.expire(), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [expiresAt]);

  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'health' && q.queryKey[0] !== 'auth' });
  }, [epoch, queryClient]);

  const login = useCallback(
    async (input: LoginInput) => {
      const auth = await api.auth.login(input);
      session.start({ expires_at: auth.expires_at });
      queryClient.setQueryData(['auth', 'me', session.getEpoch()], auth.user);
      void api.ensureCsrf(true).catch(() => undefined);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* already invalid */
    }
    session.clear();
    queryClient.clear();
    void api.ensureCsrf(true).catch(() => undefined);
  }, [queryClient]);

  const status: AuthStatus = me.data ? 'authenticated' : me.isError ? 'anonymous' : 'loading';
  const value = useMemo(() => ({ status, user: me.data ?? null, login, logout }), [status, me.data, login, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
