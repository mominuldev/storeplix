import { storeTag } from './cache-tags';
import { PREVIEW_HEADER } from './preview-token';

export interface ConfigRequestEnv {
  apiUrl: string;
  apiKey: string;
  revalidateSeconds: number;
}

export type StorefrontRequestInit = RequestInit & { next?: { tags?: string[]; revalidate?: number } };

/** Revalidate window for `/storefront/pages*` (contract §5.2); tag revalidation is immediate. */
export const PAGES_REVALIDATE_SECONDS = 300;

/**
 * Build a fetch for a `/api/v1/storefront/*` endpoint. Two strictly separate cache modes:
 *  - public  (no preview token): shared Next data cache, tag `store:{host}`. The request carries
 *    no per-visitor input, so the cached body is exactly what every public visitor must see.
 *  - preview (token present): `cache: 'no-store'`, no tags, never read from or written to the
 *    shared cache - so a preview/draft payload can't be served publicly and a cached public
 *    payload can't mask a preview.
 */
export function buildStorefrontRequest(
  path: string,
  host: string,
  previewToken: string | null,
  env: Pick<ConfigRequestEnv, 'apiUrl' | 'apiKey'>,
  revalidateSeconds: number,
  clientIp: string | null = null,
): { url: string; init: StorefrontRequestInit } {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Host': host,
    'X-Storefront-Key': env.apiKey,
  };
  const url = `${env.apiUrl}/api/v1/storefront${path}`;

  if (previewToken) {
    headers[PREVIEW_HEADER] = previewToken;
    // Per-visitor (no-store) only: lets the API apply the per-shopper limit (5b §2.10).
    if (clientIp) headers['X-Storefront-Client-Ip'] = clientIp;
    return { url, init: { headers, cache: 'no-store' } };
  }
  return { url, init: { headers, next: { tags: [storeTag(host)], revalidate: revalidateSeconds } } };
}

/** GET /storefront/config. */
export function buildConfigRequest(host: string, previewToken: string | null, env: ConfigRequestEnv, clientIp: string | null = null) {
  return buildStorefrontRequest('/config', host, previewToken, env, env.revalidateSeconds, clientIp);
}

/** GET /storefront/pages/{slug} (slug must already match the page slug regex). */
export function buildPageRequest(host: string, slug: string, previewToken: string | null, env: Pick<ConfigRequestEnv, 'apiUrl' | 'apiKey'>, clientIp: string | null = null) {
  return buildStorefrontRequest(`/pages/${encodeURIComponent(slug)}`, host, previewToken, env, PAGES_REVALIDATE_SECONDS, clientIp);
}

/** GET /storefront/pages (sitemap). Published pages only, so it is always fetched publicly. */
export function buildPageIndexRequest(host: string, env: Pick<ConfigRequestEnv, 'apiUrl' | 'apiKey'>) {
  return buildStorefrontRequest('/pages', host, null, env, PAGES_REVALIDATE_SECONDS);
}

/** Query for GET /storefront/products (contract §3.8). */
export interface ProductFeedQuery {
  sort: 'latest' | 'bestsellers';
  limit: number;
  onSale?: boolean;
}

/** Revalidate window for the product feed (contract §8); product saves also revalidate the store tag. */
export const PRODUCTS_REVALIDATE_SECONDS = 300;

/**
 * GET /storefront/products. Same cache split as config: public → tag `store:{host}` + 300 s,
 * preview → `no-store` with the preview header forwarded.
 */
export function buildProductFeedRequest(
  host: string,
  query: ProductFeedQuery,
  previewToken: string | null,
  env: Pick<ConfigRequestEnv, 'apiUrl' | 'apiKey'>,
  clientIp: string | null = null,
) {
  const limit = Math.min(24, Math.max(1, Math.trunc(query.limit)));
  const params = new URLSearchParams({ sort: query.sort, limit: String(limit) });
  if (query.onSale) params.set('on_sale', '1');
  return buildStorefrontRequest(`/products?${params.toString()}`, host, previewToken, env, PRODUCTS_REVALIDATE_SECONDS, clientIp);
}
