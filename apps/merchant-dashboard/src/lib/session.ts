import { createAuthSession } from '@storeplix/api-client';

/** Token + expires_at in sessionStorage; active tenant/store in localStorage (contract D1/D3). */
export const session = createAuthSession({ prefix: 'storeplix.merchant' });
