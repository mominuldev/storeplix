import { createApiClient, isImpersonationEnded } from '@storeplix/api-client';
import { expireSession, impersonation } from '../impersonation/store';
import { session } from './session';

// Phase 4.7b (contract §7.1/§7.3): same-origin. `/api` and `/sanctum` reach Laravel through the Vite proxy (dev) or
// Nginx (prod), so the session cookie is host-only and no CORS is involved.
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? '',
  credentials: 'same-origin',
  getTenantId: session.getTenantId,
  // Session rejected or expired: clear and send the user to /login with a notice. Phase 8.1: inside an impersonation
  // (or on 401 `impersonation_ended`) show "Impersonation ended" instead of the login page.
  onUnauthorized: (error) => (isImpersonationEnded(error) ? impersonation.end() : expireSession()),
});
