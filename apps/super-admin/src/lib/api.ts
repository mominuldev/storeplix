import { createApiClient } from '@storeplix/api-client';
import { session } from './session';

// Phase 4.7b (contract §7.1/§7.3): same-origin through the Vite proxy (dev) / Nginx on admin.storeplix.com (prod).
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? '',
  credentials: 'same-origin',
  getTenantId: session.getTenantId,
  // Session rejected or expired: clear and send the user to /login with a notice.
  onUnauthorized: () => session.expire(),
});
