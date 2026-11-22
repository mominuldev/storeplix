import { normalizeHost } from './host';
import { originForHost } from './seo';

/**
 * Phase 6 primary-domain redirects (PHASE-6-CONTRACT P6-15, §7). Pure functions (no Next imports)
 * shared by the proxy, the store lookup and the robots/sitemap handlers.
 *
 * The API alone decides *whether* to redirect (`store.redirect_host`, computed from the DB primary
 * for the looked-up request host; null for previews). The storefront only decides *how*: page
 * requests (GET/HEAD) get a 308, robots.txt/sitemap.xml a 301, `/api/*` and Server Actions never.
 */

/**
 * Internal request header carrying the original path + query of a GET/HEAD page request. Written
 * (or deleted) by the proxy on every request, so a client-supplied value never reaches the server.
 * Absent = do not redirect (POST/Server Action, /api/*, proxy did not run).
 */
export const STOREFRONT_PATH_HEADER = 'x-storeplix-path';

const MAX_PATH_LENGTH = 8192;

/**
 * `redirect_host` from the wire: a bare normalised hostname or null. Anything with a scheme, port,
 * path, userinfo or other junk is ignored (null), never a redirect to an unparsable value (S46).
 */
export function parseRedirectHost(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || /[:/@\\?#\s]/.test(v)) return null;
  return normalizeHost(v);
}

const hasControlChar = (s: string) => Array.from(s).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const isRedirectableMethod = (method: string) => method === 'GET' || method === 'HEAD';
const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');

/**
 * Value for STOREFRONT_PATH_HEADER, or null when this request must never be redirected (non-GET/HEAD
 * incl. Server Action POSTs, `/api/*` route handlers). `search` is `URL.search` ('' or '?…').
 */
export function redirectablePath(method: string, pathname: string, search: string): string | null {
  if (!isRedirectableMethod(method) || isApiPath(pathname)) return null;
  const value = `${pathname}${search}`;
  return value.length <= MAX_PATH_LENGTH ? value : null;
}

/**
 * Absolute redirect target `{origin(primary)}{path}{query}`, or null for "no redirect": no or invalid
 * `redirect_host`, the request already on that host (no loops), a preview render, or a missing/unsafe
 * path. The origin is always built by our own helper, so the target can only be the primary host.
 */
export function primaryRedirectTarget(input: {
  redirectHost: string | null | undefined;
  requestHost: string;
  preview: boolean;
  path: string | null | undefined;
}): string | null {
  const host = parseRedirectHost(input.redirectHost);
  if (!host || input.preview || host === input.requestHost) return null;
  const path = input.path;
  // Must be an absolute path on the target origin; `//x` or `/\x` could be read as a network path.
  if (typeof path !== 'string' || !path.startsWith('/') || /^\/[/\\]/.test(path) || hasControlChar(path)) return null;
  const pathname = path.split('?', 1)[0]!;
  if (isApiPath(pathname)) return null;
  const origin = originForHost(host);
  try {
    const url = new URL(origin + path);
    return url.origin === new URL(origin).origin ? origin + path : null;
  } catch {
    return null;
  }
}
