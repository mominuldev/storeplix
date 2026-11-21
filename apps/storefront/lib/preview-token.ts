/**
 * Merchant preview token plumbing (contract D2). Pure helpers shared by the proxy, server code
 * and tests. The token itself is opaque and verified only by Laravel (signed, store-bound, 60 min).
 */
export const PREVIEW_PARAM = 'preview';
export const PREVIEW_COOKIE = 'sp_preview';
export const PREVIEW_HEADER = 'X-Storefront-Preview';
export const PREVIEW_MAX_AGE = 3600;

const TOKEN_RE = /^[A-Za-z0-9._~+/=:|-]{1,1024}$/;

/** Accept only a plausible opaque token; anything else is treated as "no preview". */
export function sanitizePreviewToken(value: unknown): string | null {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : null;
}
