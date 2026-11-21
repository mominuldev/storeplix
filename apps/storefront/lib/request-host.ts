import 'server-only';
import { headers } from 'next/headers';
import { STOREFRONT_HOST_HEADER, isTrustedProxy, normalizeHost, resolveRequestHost } from './host';

/**
 * The normalized host for the current request. The proxy always overwrites
 * STOREFRONT_HOST_HEADER, but we re-normalize defensively and fall back to resolving from the
 * raw headers if the proxy did not run for some route.
 */
export async function getRequestHost(): Promise<string | null> {
  const h = await headers();
  const fromProxy = h.get(STOREFRONT_HOST_HEADER);
  if (fromProxy !== null) return normalizeHost(fromProxy);
  return resolveRequestHost(h, { trustedProxy: isTrustedProxy() });
}
