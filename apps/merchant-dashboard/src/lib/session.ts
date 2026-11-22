import { createSessionStore } from '@storeplix/api-client';

/** Phase 4.7b: cookie session — only expires_at + signed-in flag (sessionStorage) and the tenant preference (localStorage). */
export const session = createSessionStore({ prefix: 'storeplix.merchant' });
