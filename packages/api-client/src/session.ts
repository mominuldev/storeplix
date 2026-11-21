// Browser auth-session store shared by the merchant dashboard and super-admin (framework-free).
// Phase 1.1 (contract D3): token + expires_at live in sessionStorage; preferences (active tenant)
// in localStorage. `expire()` leaves a one-shot notice so the login screen can explain what happened.

export type SessionNotice = 'session_expired';

export interface AuthSessionOptions {
  /** Key prefix, e.g. `storeplix.merchant`. */
  prefix: string;
  /** Defaults to window.sessionStorage. */
  tokenStorage?: Storage;
  /** Defaults to window.localStorage. */
  prefsStorage?: Storage;
  now?: () => number;
}

export interface AuthSession {
  getToken(): string | null;
  getExpiresAt(): string | null;
  /** True when a token exists and `expires_at` has passed. */
  isExpired(): boolean;
  /** Milliseconds until expiry (null when no expiry is known). */
  msUntilExpiry(): number | null;
  setAuth(auth: { token: string; expires_at?: string | null }): void;
  getTenantId(): string | null;
  setTenantId(id: string | null): void;
  /** User-initiated sign-out. */
  clear(): void;
  /** Token rejected or expired: clear and leave a `session_expired` notice. No-op when signed out. */
  expire(): void;
  /** Reads and removes the pending notice. */
  consumeNotice(): SessionNotice | null;
  peekNotice(): SessionNotice | null;
  subscribe(listener: () => void): () => void;
}

function safe(storage: () => Storage | undefined) {
  return {
    get(key: string): string | null {
      try {
        return storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null) {
      try {
        const s = storage();
        if (!s) return;
        if (value === null) s.removeItem(key);
        else s.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export function createAuthSession(options: AuthSessionOptions): AuthSession {
  const { prefix } = options;
  const now = options.now ?? Date.now;
  const tokens = safe(() => options.tokenStorage ?? globalThis.sessionStorage);
  const prefs = safe(() => options.prefsStorage ?? globalThis.localStorage);
  const keys = {
    token: `${prefix}.token`,
    expiresAt: `${prefix}.expires_at`,
    notice: `${prefix}.notice`,
    tenant: `${prefix}.tenant`,
  };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const session: AuthSession = {
    getToken: () => tokens.get(keys.token),
    getExpiresAt: () => tokens.get(keys.expiresAt),
    msUntilExpiry() {
      const raw = tokens.get(keys.expiresAt);
      if (!raw) return null;
      const at = Date.parse(raw);
      return Number.isNaN(at) ? null : at - now();
    },
    isExpired() {
      const ms = session.msUntilExpiry();
      return !!session.getToken() && ms !== null && ms <= 0;
    },
    setAuth({ token, expires_at }) {
      tokens.set(keys.token, token);
      tokens.set(keys.expiresAt, expires_at ?? null);
      tokens.set(keys.notice, null);
      emit();
    },
    getTenantId: () => prefs.get(keys.tenant),
    setTenantId(id) {
      prefs.set(keys.tenant, id);
      emit();
    },
    clear() {
      tokens.set(keys.token, null);
      tokens.set(keys.expiresAt, null);
      emit();
    },
    expire() {
      if (!session.getToken()) return;
      tokens.set(keys.token, null);
      tokens.set(keys.expiresAt, null);
      tokens.set(keys.notice, 'session_expired');
      emit();
    },
    peekNotice: () => tokens.get(keys.notice) as SessionNotice | null,
    consumeNotice() {
      const notice = tokens.get(keys.notice) as SessionNotice | null;
      if (notice) tokens.set(keys.notice, null);
      return notice;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return session;
}

export const SESSION_EXPIRED_MESSAGE = 'Your session expired, please sign in again';
