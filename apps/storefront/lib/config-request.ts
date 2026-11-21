import { storeTag } from './cache-tags';
import { PREVIEW_HEADER } from './preview-token';

export interface ConfigRequestEnv {
  apiUrl: string;
  apiKey: string;
  revalidateSeconds: number;
}

/**
 * Build the fetch for GET /storefront/config. Two strictly separate cache modes:
 *  - public  (no preview token): shared Next data cache, tag `store:{host}`. The request carries
 *    no per-visitor input, so the cached body is exactly what every public visitor must see.
 *  - preview (token present): `cache: 'no-store'`, no tags, never read from or written to the
 *    shared cache - so a preview/draft payload can't be served publicly and a cached public
 *    payload can't mask a preview.
 */
export function buildConfigRequest(
  host: string,
  previewToken: string | null,
  env: ConfigRequestEnv,
): { url: string; init: RequestInit & { next?: { tags?: string[]; revalidate?: number } } } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Host': host,
    'X-Storefront-Key': env.apiKey,
  };
  const url = `${env.apiUrl}/api/v1/storefront/config`;

  if (previewToken) {
    headers[PREVIEW_HEADER] = previewToken;
    return { url, init: { headers, cache: 'no-store' } };
  }
  return { url, init: { headers, next: { tags: [storeTag(host)], revalidate: env.revalidateSeconds } } };
}
