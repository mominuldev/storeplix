import type { AdminSession, PlatformUser } from '@storeplix/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../lib/api';
import { idleNotice, session } from '../lib/session';

type AuthStatus = 'anonymous' | 'loading' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: PlatformUser | null;
  /** Call after the TOTP / enrolment step answered `AdminSession` (the session cookie is already set). */
  signIn: (s: AdminSession) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'mousemove'] as const;

// Phase 8.1 (§3.1, P8-5): admin surface session. Boot = GET /admin/auth/me (200 signed in, 401 signed out).
// Absolute expiry (12 h, `session_expires_at`) → proactive sign-out with the "session expired" notice.
// Idle expiry (30 min, `idle_expires_at`, refreshed by /admin/auth/me): shortly before it, the session is refreshed
// when the staff member did something since the last refresh, otherwise they are signed out with the idle notice.
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
      const s = await api.admin.auth.me();
      // Past the absolute expiry (clock skew, stale tab): treat as signed out instead of looping.
      if (s.session_expires_at && Date.parse(s.session_expires_at) <= Date.now()) {
        session.expire();
        throw new Error('session_expired');
      }
      session.start({ expires_at: s.session_expires_at });
      return s;
    },
    retry: false,
    staleTime: Infinity,
  });

  // Absolute expiry timer.
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

  // Idle timer.
  const lastActivity = useRef(0);
  const signedIn = !!me.data;
  useEffect(() => {
    if (!signedIn) return;
    const mark = () => {
      lastActivity.current = Date.now();
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, mark, { passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, mark);
    };
  }, [signedIn]);

  const idleAt = me.data?.idle_expires_at ?? null;
  const refreshedAt = me.dataUpdatedAt;
  const refetch = me.refetch;
  useEffect(() => {
    if (!idleAt) return;
    const at = Date.parse(idleAt);
    if (Number.isNaN(at)) return;
    // Decide one minute before the server would drop the session.
    const ms = Math.max(0, at - Date.now() - 60_000);
    const id = setTimeout(() => {
      if (lastActivity.current > refreshedAt) {
        void refetch();
      } else {
        idleNotice.set();
        session.expire();
      }
    }, Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [idleAt, refreshedAt, refetch]);

  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== 'health' && q.queryKey[0] !== 'auth',
    });
  }, [epoch, queryClient]);

  const signIn = useCallback(
    (s: AdminSession) => {
      idleNotice.clear();
      session.start({ expires_at: s.session_expires_at });
      queryClient.setQueryData(['auth', 'me', session.getEpoch()], s);
      void api.ensureCsrf(true).catch(() => undefined);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.admin.auth.logout();
    } catch {
      /* already invalid */
    }
    session.clear();
    queryClient.clear();
    void api.ensureCsrf(true).catch(() => undefined);
  }, [queryClient]);

  const status: AuthStatus = me.data ? 'authenticated' : me.isError ? 'anonymous' : 'loading';
  const user = me.data?.user ?? null;
  const value = useMemo(() => ({ status, user, signIn, logout }), [status, user, signIn, logout]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
