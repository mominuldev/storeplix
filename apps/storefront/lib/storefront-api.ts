import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import type { StorefrontConfig } from '@storeplix/types';
import { serverEnv } from './env';
import { storeTag } from './cache-tags';

/** Render-only store data validated at the boundary. `theme` is validated later by the theme engine. */
const StorefrontConfigSchema = z.object({
  store: z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(100),
    currency: z.string().regex(/^[A-Za-z]{3}$/).catch('BDT'),
    logo_url: z.string().max(2048).nullable().catch(null),
    favicon_url: z.string().max(2048).nullable().catch(null),
  }),
  theme: z.unknown().optional(),
  seo: z
    .object({
      title: z.string().max(300).catch(''),
      description: z.string().max(1000).nullable().catch(null),
    })
    .catch({ title: '', description: null }),
});

/** Store config whose `theme` is still untrusted input for the theme engine. */
export type RawStorefrontConfig = Omit<StorefrontConfig, 'theme'> & { theme?: unknown };

export type StorefrontConfigResult =
  | { status: 'found'; config: RawStorefrontConfig }
  | { status: 'not_found' };

export class StorefrontApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'StorefrontApiError';
  }
}

async function fetchStorefrontConfig(host: string): Promise<StorefrontConfigResult> {
  const apiKey = serverEnv.apiKey;
  if (!apiKey) throw new StorefrontApiError('STOREFRONT_API_KEY is not configured');

  let res: Response;
  try {
    res = await fetch(`${serverEnv.apiUrl}/api/v1/storefront/config`, {
      headers: {
        Accept: 'application/json',
        'X-Storefront-Host': host,
        'X-Storefront-Key': apiKey,
      },
      next: { tags: [storeTag(host)], revalidate: serverEnv.configRevalidateSeconds },
    });
  } catch (err) {
    throw new StorefrontApiError(`Storefront API unreachable: ${(err as Error).message}`);
  }

  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) throw new StorefrontApiError(`Storefront API responded ${res.status}`, res.status);

  const body: unknown = await res.json().catch(() => null);
  const parsed = z.object({ data: StorefrontConfigSchema }).safeParse(body);
  if (!parsed.success) throw new StorefrontApiError('Storefront API returned an invalid config payload');
  return { status: 'found', config: parsed.data.data };
}

/**
 * Server-side store config lookup for a normalized host. Deduplicated per request (React cache)
 * and cached across requests by the Next data cache under tag `store:{host}`.
 */
export const getStorefrontConfig = cache(fetchStorefrontConfig);
