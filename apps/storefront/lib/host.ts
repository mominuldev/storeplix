/**
 * Hostname normalization for tenant resolution. Pure functions (no Next imports) so they
 * can run in the proxy, server components and unit tests alike.
 *
 * Security: the tenant is derived ONLY from the `Host` header unless the deployment
 * explicitly opts in to trusting `X-Forwarded-Host` (TRUSTED_PROXY=true, e.g. behind our
 * own Nginx/Cloudflare which overwrite the header). Even then Laravel validates the host
 * against `store_domains`, so a spoofed host can at worst resolve to "store not found".
 */

/** Request header the proxy sets for server components. Always overwritten by the proxy. */
export const STOREFRONT_HOST_HEADER = 'x-storeplix-host';

const MAX_HOST_LENGTH = 253;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT_RE = /^\d{1,5}$/;

/**
 * Normalize a raw Host header value: trim, lowercase, strip port and a single trailing dot.
 * Returns null for anything that is not a plain DNS hostname (IPv6 literals, userinfo,
 * paths, unicode, empty labels, over-long names, multiple values, bad ports...).
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH + 7) return null;

  // Strip an optional port. Anything with more than one ':' (IPv6, garbage) is rejected.
  const colon = host.indexOf(':');
  if (colon !== -1) {
    if (host.indexOf(':', colon + 1) !== -1) return null;
    const port = host.slice(colon + 1);
    if (!PORT_RE.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
    host = host.slice(0, colon);
  }

  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;

  const labels = host.split('.');
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  // A purely numeric TLD means an IPv4 literal (or junk) - never a store domain.
  if (labels.length > 1 && /^\d+$/.test(labels[labels.length - 1]!)) return null;

  return host;
}

export interface HeaderSource {
  get(name: string): string | null;
}

export interface ResolveHostOptions {
  /** Only when true is X-Forwarded-Host considered. Default: false. */
  trustedProxy?: boolean;
}

/** Pick the request host from headers and normalize it. Returns null when malformed/missing. */
export function resolveRequestHost(headers: HeaderSource, opts: ResolveHostOptions = {}): string | null {
  if (opts.trustedProxy) {
    const forwarded = headers.get('x-forwarded-host');
    if (forwarded) {
      // Proxies may append; the left-most value is the one the client sent to our edge.
      const first = forwarded.split(',')[0];
      return normalizeHost(first);
    }
  }
  return normalizeHost(headers.get('host'));
}

/** Parse the TRUSTED_PROXY env flag. Only explicit truthy values enable it. */
export function isTrustedProxy(value: string | undefined = process.env.TRUSTED_PROXY): boolean {
  return value === 'true' || value === '1';
}
