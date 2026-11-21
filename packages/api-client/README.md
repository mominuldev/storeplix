# @storeplix/api-client

Framework-free typed client for the Store Plix API (`/api/v1`). Unwraps `{data}` envelopes and throws `ApiError` (`status`, `code`, `message`, `details`) for `{error}` envelopes, non-JSON errors (`http_error`), network failures (`network_error`, status 0) and malformed bodies (`invalid_response`).

```ts
import { createApiClient, ApiError } from '@storeplix/api-client';

const api = createApiClient({
  baseUrl: 'http://localhost:8000',          // /api/v1 appended
  getToken: () => localStorage.getItem('token'),
  getTenantId: () => currentTenantId,        // sent as X-Tenant-Id
  onUnauthorized: () => logout(),
});

await api.health();
await api.auth.login({ email, password });   // → { token, user }
await api.stores.list();                      // → { data: Store[], meta }

// Next.js server only (secret key):
const config = await api.storefront.getConfig(host, process.env.STOREFRONT_API_KEY!, {
  init: { next: { revalidate: 60 } },
});
```
