/** Local dev hosts (*.localhost, *.test) are served over plain http. */
export function isLocalDevHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test');
}

/**
 * Canonical origin for a normalized host. Local dev hosts use http and the dev port
 * (STOREFRONT_LOCAL_PORT, default 3000) because host normalization strips ports.
 */
export function originForHost(host: string): string {
  if (!isLocalDevHost(host)) return `https://${host}`;
  const port = process.env.STOREFRONT_LOCAL_PORT ?? '3000';
  return /^\d{1,5}$/.test(port) && port !== '80' ? `http://${host}:${port}` : `http://${host}`;
}
