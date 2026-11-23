import type { MeImpersonation } from '@storeplix/types';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { impersonation } from './store';

/** The active impersonation (`/auth/me` meta.impersonation), or null. */
export function useImpersonation(): MeImpersonation | null {
  return useSyncExternalStore(impersonation.subscribe, impersonation.get, () => null);
}

export function useImpersonationEnded(): boolean {
  return useSyncExternalStore(impersonation.subscribe, impersonation.isEnded, () => false);
}

/**
 * Contract §7.2: true inside a read-only support (impersonation) session. Primary create/save actions use it to render
 * disabled; the API refuses every write anyway (403 `impersonation_read_only`).
 */
export function useReadOnly(): boolean {
  return useImpersonation() !== null;
}

/** Milliseconds until `expiresAt` (≥ 0), ticking every second; null without a deadline. */
export function useCountdown(expiresAt: string | null | undefined, now: () => number = Date.now): number | null {
  const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    if (Number.isNaN(deadline)) return;
    const id = setInterval(() => setNowMs(now()), 1000);
    return () => clearInterval(id);
  }, [deadline, now]);
  return Number.isNaN(deadline) ? null : Math.max(0, deadline - nowMs);
}

/** `mm:ss` (minutes are not capped at 59, impersonations last 15 minutes). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
