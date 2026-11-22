// Browser auth-session store shared by the merchant dashboard and super-admin (framework-free).
// Phase 4.7b (PHASE-4-CONTRACT §7.3): the session itself is an HttpOnly cookie the JS never sees. This store keeps
// only non-secret state: the absolute `expires_at` (sessionStorage, for the proactive logout timer), the active
// tenant preference (localStorage) and a one-shot "session expired" notice. No token is ever stored.

export type SessionNotice = 'session_expired';

export interface SessionStoreOptions {
  /** Key prefix, e.g. `storeplix.merchant`. */
  prefix: string;
  /** Defaults to window.sessionStorage (expiry + notice). */
  sessionStorage?: Storage;
  /** Defaults to window.localStorage (tenant preference). */
  prefsStorage?: Storage;
  now?: () => number;
}

export interface SessionStore {
  /** True after a sign-in (or a successful `/auth/me`) until sign-out or expiry. */
  isSignedIn(): boolean;
  getExpiresAt(): string | null;
  /** Milliseconds until the absolute expiry (null when unknown). */
  msUntilExpiry(): number | null;
  /** Signed in and `expires_at` has passed. */
  isExpired(): boolean;
  /** Mark the session as started (login, `/auth/me` 200). Clears any notice. */
  start(auth: { expires_at?: string | null }): void;
  /** Bumps when a session ends (clear / expire); use it in the `/auth/me` query key so it re-runs. */
  getEpoch(): number;
  getTenantId(): string | null;
  setTenantId(id: string | null): void;
  /** User-initiated sign-out. */
  clear(): void;
  /** Session rejected (401) or past its expiry: clear and leave a `session_expired` notice. No-op when signed out. */
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

const SIGNED_IN = '1';

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const { prefix } = options;
  const now = options.now ?? Date.now;
  const tab = safe(() => options.sessionStorage ?? globalThis.sessionStorage);
  const prefs = safe(() => options.prefsStorage ?? globalThis.localStorage);
  const keys = {
    signedIn: `${prefix}.signed_in`,
    expiresAt: `${prefix}.expires_at`,
    notice: `${prefix}.notice`,
    tenant: `${prefix}.tenant`,
  };

  let epoch = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const end = (notice: SessionNotice | null) => {
    tab.set(keys.signedIn, null);
    tab.set(keys.expiresAt, null);
    tab.set(keys.notice, notice);
    epoch++;
    notify();
  };

  const store: SessionStore = {
    isSignedIn: () => tab.get(keys.signedIn) === SIGNED_IN,
    getExpiresAt: () => tab.get(keys.expiresAt),
    msUntilExpiry() {
      const raw = tab.get(keys.expiresAt);
      if (!raw) return null;
      const at = Date.parse(raw);
      return Number.isNaN(at) ? null : at - now();
    },
    isExpired() {
      const ms = store.msUntilExpiry();
      return store.isSignedIn() && ms !== null && ms <= 0;
    },
    start({ expires_at }) {
      const changed = !store.isSignedIn() || (expires_at ?? null) !== store.getExpiresAt() || store.peekNotice() !== null;
      tab.set(keys.signedIn, SIGNED_IN);
      tab.set(keys.expiresAt, expires_at ?? null);
      tab.set(keys.notice, null);
      if (changed) notify();
    },
    getEpoch: () => epoch,
    getTenantId: () => prefs.get(keys.tenant),
    setTenantId(id) {
      prefs.set(keys.tenant, id);
      notify();
    },
    clear: () => end(null),
    expire() {
      if (!store.isSignedIn()) return;
      end('session_expired');
    },
    peekNotice: () => tab.get(keys.notice) as SessionNotice | null,
    consumeNotice() {
      const notice = tab.get(keys.notice) as SessionNotice | null;
      if (notice) tab.set(keys.notice, null);
      return notice;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

export const SESSION_EXPIRED_MESSAGE = 'Your session expired, please sign in again';
