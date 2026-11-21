/**
 * Media origins (API `/storage` locally, the CDN in prod) from STOREFRONT_MEDIA_ORIGINS, a
 * comma-separated list of exact origins, e.g. "http://localhost:8000,https://cdn.storeplix.com".
 * Used both for next.config `images.remotePatterns` (build time) and for URL checks at runtime.
 * No wildcards: anything not listed is never optimized, and http is only accepted for listed origins.
 */
export function parseMediaOrigins(value: string | undefined = process.env.STOREFRONT_MEDIA_ORIGINS): URL[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .flatMap((s) => {
      try {
        const u = new URL(s);
        const ok = (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hostname;
        return ok && !u.hostname.includes('*') ? [u] : [];
      } catch {
        return [];
      }
    });
}

export function isAllowedMediaOrigin(url: string, origins: URL[] = parseMediaOrigins()): boolean {
  try {
    const u = new URL(url);
    return origins.some((o) => o.origin === u.origin);
  } catch {
    return false;
  }
}

/** next.config remotePatterns for the configured origins. */
export function mediaRemotePatterns(origins: URL[] = parseMediaOrigins()) {
  return origins.map((o) => ({
    protocol: o.protocol.slice(0, -1) as 'http' | 'https',
    hostname: o.hostname,
    port: o.port,
    pathname: '/**',
  }));
}
