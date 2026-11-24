import { normalizeHost } from '@/lib/host';

/**
 * Form-post check for `/u/{code}/change`. The page is `Referrer-Policy: no-referrer`, so browsers send `Origin: null`
 * for its own form; `Sec-Fetch-Site` (when sent) must then say same-origin. A real Origin must be this shop's host.
 * (The 10-char code is itself the capability; this only stops other sites from posting it blind.)
 */
export function sameOrigin(origin: string | null, host: string, fetchSite: string | null = null): boolean {
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  if (origin === null || origin === 'null') return true;
  try {
    return normalizeHost(new URL(origin).host) === normalizeHost(host);
  } catch {
    return false;
  }
}
