import { createApiClient } from '@storeplix/api-client';
import { session } from './session';

export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8000',
  getToken: session.getToken,
  getTenantId: session.getTenantId,
  onUnauthorized: () => session.clear(),
});
