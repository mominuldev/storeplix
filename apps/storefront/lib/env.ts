import 'server-only';

/** Server-only environment. STOREFRONT_API_KEY and REVALIDATE_SECRET must never reach the client. */
export const serverEnv = {
  get apiUrl(): string {
    return (process.env.STOREFRONT_API_URL ?? 'http://localhost:8010').replace(/\/+$/, '');
  },
  get apiKey(): string | undefined {
    return process.env.STOREFRONT_API_KEY || undefined;
  },
  get revalidateSecret(): string | undefined {
    return process.env.REVALIDATE_SECRET || undefined;
  },
  get configRevalidateSeconds(): number {
    const n = Number(process.env.STOREFRONT_CONFIG_REVALIDATE ?? 60);
    return Number.isFinite(n) && n >= 0 ? n : 60;
  },
};
