// Persisted auth session (Bearer token + active tenant). Phase 1: localStorage per contract (Sanctum PAT).
type Listener = () => void;

const TOKEN_KEY = 'storeplix.admin.token';
const TENANT_KEY = 'storeplix.admin.tenant';
const listeners = new Set<Listener>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) — session lives for this tab only */
  }
  listeners.forEach((l) => l());
}

export const session = {
  getToken: () => read(TOKEN_KEY),
  setToken: (token: string | null) => write(TOKEN_KEY, token),
  getTenantId: () => read(TENANT_KEY),
  setTenantId: (id: string | null) => write(TENANT_KEY, id),
  clear() {
    write(TOKEN_KEY, null);
    write(TENANT_KEY, null);
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
