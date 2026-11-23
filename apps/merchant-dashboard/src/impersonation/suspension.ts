import { useSyncExternalStore } from 'react';

// Phase 8.1 (P8-12): the tenant id the API answered 403 `tenant_suspended` for. StoreGate shows the suspended screen
// for it; switching to another shop (or signing out) is unaffected.

let suspendedTenantId: string | null = null;
const listeners = new Set<() => void>();

export const suspension = {
  get: () => suspendedTenantId,
  mark(tenantId: string | null) {
    if (!tenantId || tenantId === suspendedTenantId) return;
    suspendedTenantId = tenantId;
    listeners.forEach((l) => l());
  },
  reset() {
    if (suspendedTenantId === null) return;
    suspendedTenantId = null;
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useSuspendedTenantId(): string | null {
  return useSyncExternalStore(suspension.subscribe, suspension.get, () => null);
}
