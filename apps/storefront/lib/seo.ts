/**
 * Canonical origin for a normalized host. Local dev hosts (*.localhost, *.test) use http and the
 * dev port (STOREFRONT_LOCAL_PORT, default 3000) because host normalization strips ports.
 */
export function originForHost(host: string): string {
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test');
  if (!local) return `https://${host}`;
  const port = process.env.STOREFRONT_LOCAL_PORT ?? '3000';
  return /^\d{1,5}$/.test(port) && port !== '80' ? `http://${host}:${port}` : `http://${host}`;
}
