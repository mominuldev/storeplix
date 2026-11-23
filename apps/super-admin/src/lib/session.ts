import { createSessionStore } from '@storeplix/api-client';

/** Phase 4.7b: cookie session — only expires_at + a signed-in flag in sessionStorage, never a token. */
export const session = createSessionStore({ prefix: 'storeplix.admin' });

// Phase 8.1 (P8-5): the 30-minute idle sign-out leaves its own one-shot notice next to the store's `session_expired`.
const IDLE_KEY = 'storeplix.admin.idle_notice';

export const idleNotice = {
  set() {
    try {
      sessionStorage.setItem(IDLE_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  },
  peek(): boolean {
    try {
      return sessionStorage.getItem(IDLE_KEY) === '1';
    } catch {
      return false;
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(IDLE_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};
