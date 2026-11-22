import 'server-only';
import { headers } from 'next/headers';
import { STOREFRONT_HOST_HEADER, isTrustedProxy, normalizeHost, resolveRequestHost } from './host';
import { STOREFRONT_PATH_HEADER } from './primary-host';

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

/**
 * Path + query of the current GET/HEAD page request as written by the proxy, or null (POST/Server
 * Action, `/api/*`, or the proxy did not run): null means "never redirect".
 */
export async function getRedirectablePath(): Promise<string | null> {
  return (await headers()).get(STOREFRONT_PATH_HEADER);
}
