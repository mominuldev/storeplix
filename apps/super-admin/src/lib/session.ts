import { createAuthSession } from '@storeplix/api-client';

/** Token + expires_at in sessionStorage (contract D3). */
export const session = createAuthSession({ prefix: 'storeplix.admin' });
