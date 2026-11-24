import { isSuspendedConfigBody } from './suspended-config';

/**
 * Phase 8.1 (P8-12): does this host belong to a suspended shop? Asked by the proxy, because only the proxy can answer
 * with HTTP 503 (a page render always commits to 200/404). Same request as the server components'
 * `GET /storefront/config` (public, no preview token: a suspended shop is unavailable to previews too).
 *
 * Answers are kept per process for a short TTL so the extra lookup costs at most one API call per host every
 * SUSPENSION_TTL_MS (the API's suspend/reactivate cache bust reaches this within that window). Failures are never
 * cached and never block a page: on any error the request renders normally (and the render path, which sees the same
 * config, falls back to the unavailable page itself).
 */
export const SUSPENSION_TTL_MS = 15_000;
const MAX_ENTRIES = 2000;
const TIMEOUT_MS = 3000;

type Entry = { suspended: boolean; at: number };
const answers = new Map<string, Entry>();
const inflight = new Map<string, Promise<boolean>>();

export interface SuspensionCheckOptions {
  fetch?: typeof fetch;
  now?: () => number;
  apiUrl?: string;
  apiKey?: string;
}

/** Hosts the proxy never checks: Next internals, our static platform files and the storefront's own JSON/route API. */
export function needsSuspensionCheck(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !/^\/(?:api|platform|_next)(?:\/|$)/.test(pathname);
}

export async function isHostSuspended(host: string, opts: SuspensionCheckOptions = {}): Promise<boolean> {
  const apiKey = opts.apiKey ?? (process.env.STOREFRONT_API_KEY || undefined);
  if (!apiKey) return false;
  const now = opts.now ?? Date.now;
  const hit = answers.get(host);
  if (hit && now() - hit.at < SUSPENSION_TTL_MS) return hit.suspended;

  const pending = inflight.get(host);
  if (pending) return pending;
  const apiUrl = (opts.apiUrl ?? process.env.STOREFRONT_API_URL ?? 'http://localhost:8010').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;

  const lookup = (async () => {
    try {
      const res = await doFetch(`${apiUrl}/api/v1/storefront/config`, {
        headers: { Accept: 'application/json', 'X-Storefront-Host': host, 'X-Storefront-Key': apiKey },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // 404 (unknown host) and errors are the render path's business.
      const suspended = res.ok ? isSuspendedConfigBody(await res.json().catch(() => null)) : false;
      if (res.ok || res.status === 404) remember(host, { suspended, at: now() });
      return suspended;
    } catch {
      return false;
    } finally {
      inflight.delete(host);
    }
  })();
  inflight.set(host, lookup);
  return lookup;
}

function remember(host: string, entry: Entry) {
  answers.delete(host);
  answers.set(host, entry);
  if (answers.size > MAX_ENTRIES) answers.delete(answers.keys().next().value!);
}

/** Tests only. */
export function clearSuspensionCache() {
  answers.clear();
  inflight.clear();
}
