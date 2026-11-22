import { createSessionStore } from '@storeplix/api-client';

/** Phase 4.7b: cookie session — only expires_at + a signed-in flag in sessionStorage, never a token. */
export const session = createSessionStore({ prefix: 'storeplix.admin' });
