import { timingSafeEqual, createHash } from 'node:crypto';
import { normalizeHost } from './host';

/** Constant-time secret comparison (hash first so lengths always match). */
export function secretMatches(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extract the bearer token from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  const m = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return m ? m[1]!.trim() : null;
}

export interface RevalidateTargets {
  /** Normalized, de-duplicated valid hosts. */
  hosts: string[];
  /** Raw entries that were not valid hostnames (echoed back, truncated, for Laravel's logs). */
  skipped: string[];
}

/**
 * Parse `{ "host": "..." }` or `{ "hosts": ["...", ...] }` (max 50). Invalid entries are skipped so
 * one bad hostname can't block a whole batch (Laravel doesn't retry on 422). Returns null only
 * when the body is malformed or contains no valid host at all.
 */
export function parseRevalidateBody(body: unknown): RevalidateTargets | null {
  if (typeof body !== 'object' || body === null) return null;
  const { host, hosts } = body as { host?: unknown; hosts?: unknown };
  const raw = Array.isArray(hosts) ? hosts : host !== undefined ? [host] : [];
  if (raw.length === 0 || raw.length > 50) return null;

  const valid = new Set<string>();
  const skipped: string[] = [];
  for (const entry of raw) {
    const normalized = typeof entry === 'string' ? normalizeHost(entry) : null;
    if (normalized) valid.add(normalized);
    else skipped.push(typeof entry === 'string' ? entry.slice(0, 255) : String(entry).slice(0, 255));
  }
  return valid.size > 0 ? { hosts: [...valid], skipped } : null;
}
