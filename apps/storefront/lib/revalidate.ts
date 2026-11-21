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

/** Parse `{ "host": "..." }` or `{ "hosts": ["...", ...] }` (max 50) into normalized hosts. */
export function parseRevalidateBody(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { host, hosts } = body as { host?: unknown; hosts?: unknown };
  const raw = Array.isArray(hosts) ? hosts : host !== undefined ? [host] : [];
  if (raw.length === 0 || raw.length > 50) return null;
  const normalized = raw.map((h) => (typeof h === 'string' ? normalizeHost(h) : null));
  if (normalized.some((h) => h === null)) return null;
  return [...new Set(normalized as string[])];
}
