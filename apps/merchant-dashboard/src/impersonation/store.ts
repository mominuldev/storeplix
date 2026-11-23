import type { MeImpersonation } from '@storeplix/types';
import { session } from '../lib/session';

// Phase 8.1 (PHASE-8-1-CONTRACT §7.2): app-wide impersonation state. `info` comes from `/auth/me` meta.impersonation (or
// the POST /auth/impersonation answer) and lives in memory only; `ended` survives a reload of this tab (sessionStorage)
// so a refreshed tab still shows "Impersonation ended" instead of the login page. `active` (sessionStorage) remembers
// that this tab is in a support session: the API answers `impersonation_ended` only once and then `unauthenticated`,
// so if that one answer is lost (navigation mid-request, reload) a plain 401 must still end the impersonation
// (QA P8-QA-8).

const ENDED_KEY = 'storeplix.merchant.impersonation_ended';
const ACTIVE_KEY = 'storeplix.merchant.impersonation_active';

let info: MeImpersonation | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function readEnded(): boolean {
  try {
    return sessionStorage.getItem(ENDED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnded(value: boolean) {
  try {
    if (value) sessionStorage.setItem(ENDED_KEY, '1');
    else sessionStorage.removeItem(ENDED_KEY);
  } catch {
    /* storage unavailable */
  }
}

function writeActive(value: boolean) {
  try {
    if (value) sessionStorage.setItem(ACTIVE_KEY, '1');
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function readActive(): boolean {
  try {
    return sessionStorage.getItem(ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

let ended = readEnded();

export const impersonation = {
  get: (): MeImpersonation | null => info,
  isEnded: (): boolean => ended,
  /** Adopt the impersonation from `/auth/me` (null outside impersonation). */
  set(next: MeImpersonation | null) {
    const changed = JSON.stringify(next) !== JSON.stringify(info);
    info = next;
    writeActive(next !== null);
    if (next && ended) {
      ended = false;
      writeEnded(false);
      emit();
      return;
    }
    if (changed) emit();
  },
  /** A fresh impersonation started from a ticket: clears a previous "ended" state. */
  begin(next: MeImpersonation) {
    info = next;
    writeActive(true);
    ended = false;
    writeEnded(false);
    emit();
  },
  /** Expired, revoked or exited: drop the local session (no "session expired" notice) and show the ended screen. */
  end() {
    const changed = info !== null || !ended;
    info = null;
    ended = true;
    writeActive(false);
    writeEnded(true);
    // Only a live session is cleared (clearing bumps the /auth/me epoch; doing it when signed out would loop).
    if (session.isSignedIn()) session.clear();
    if (changed) emit();
  },
  /** Plain sign-out / sign-in: forget everything. */
  reset() {
    info = null;
    ended = false;
    writeActive(false);
    writeEnded(false);
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Re-read sessionStorage (tests clear it between cases). */
  _reload() {
    info = null;
    ended = readEnded();
  },
};

/** A 401 or the absolute expiry: the ended screen inside impersonation, the login page with a notice otherwise. */
export function expireSession() {
  if (info || readActive()) impersonation.end();
  else session.expire();
}
