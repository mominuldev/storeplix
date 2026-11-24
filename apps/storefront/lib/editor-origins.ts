/**
 * STOREFRONT_EDITOR_ORIGINS: comma list of exact origins allowed to frame preview responses and to
 * talk to the PreviewBridge (dev `http://localhost:5183`, prod `https://app.storeplix.com`).
 * No wildcards, no paths, no credentials. Empty/invalid → [] → embedding impossible (fail closed).
 * Pure: used by the proxy (edge), server components and tests.
 */
export function parseEditorOrigins(value: string | undefined = process.env.STOREFRONT_EDITOR_ORIGINS): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const raw of value.split(',')) {
    const s = raw.trim();
    if (!s || s.includes('*')) continue;
    try {
      const u = new URL(s);
      const ok = (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hostname;
      // Must be a bare origin: "https://app.storeplix.com" (a trailing "/" is tolerated).
      if (ok && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && s.replace(/\/$/, '') === u.origin) out.add(u.origin);
    } catch {
      // ignore invalid entries
    }
  }
  return [...out];
}
