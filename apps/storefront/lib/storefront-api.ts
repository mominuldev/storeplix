import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import type { SocialLinks, StoreContact, StorefrontConfig } from '@storeplix/types';
import { serverEnv } from './env';
import { buildConfigRequest } from './config-request';

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Missing or malformed object -> `{}` so every nullable field defaults to null (rolling deploys). */
const nullableObject = <S extends z.ZodRawShape>(shape: S) => z.preprocess((v) => (isObject(v) ? v : {}), z.object(shape));
const nullableString = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);

/**
 * Render-only store data validated at the boundary. `theme` is validated later by the theme engine.
 * Contact/social values are only length-checked here; links are built and validated at render
 * (lib/contact.ts) so an unsafe value simply isn't rendered.
 */
const StorefrontConfigSchema = z.object({
  store: z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(100),
    // Unknown statuses are treated as draft: never expose a store we don't understand.
    status: z.enum(['active', 'draft']).catch('draft'),
    currency: z.string().regex(/^[A-Za-z]{3}$/).catch('BDT'),
    logo_url: z.string().max(2048).nullable().catch(null),
    favicon_url: z.string().max(2048).nullable().catch(null),
    icons: nullableObject({
      apple_touch: nullableString(2048),
      icon_192: nullableString(2048),
      icon_512: nullableString(2048),
    }),
  }),
  contact: nullableObject({
    phone: nullableString(32),
    email: nullableString(254),
    whatsapp: nullableString(32),
    support_hours: nullableString(80),
  }),
  social: nullableObject({
    facebook: nullableString(255),
    instagram: nullableString(255),
    youtube: nullableString(255),
  }),
  preview: z.boolean().catch(false),
  theme: z.unknown().optional(),
  seo: z
    .object({
      title: z.string().max(300).catch(''),
      description: z.string().max(1000).nullable().catch(null),
    })
    .catch({ title: '', description: null }),
});

/**
 * Store config whose `theme` is still untrusted input for the theme engine. Optional-on-the-wire
 * fields (icons, contact, social) are always present here, with nulls.
 */
export type RawStorefrontConfig = Omit<StorefrontConfig, 'theme' | 'store' | 'contact' | 'social'> & {
  store: StorefrontConfig['store'] & { icons: NonNullable<StorefrontConfig['store']['icons']> };
  contact: StoreContact;
  social: SocialLinks;
  theme?: unknown;
};

export type StorefrontConfigResult =
  | { status: 'found'; config: RawStorefrontConfig }
  | { status: 'not_found' };

export class StorefrontApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'StorefrontApiError';
  }
}

async function fetchStorefrontConfig(host: string, previewToken: string | null): Promise<StorefrontConfigResult> {
  const apiKey = serverEnv.apiKey;
  if (!apiKey) throw new StorefrontApiError('STOREFRONT_API_KEY is not configured');

  const { url, init } = buildConfigRequest(host, previewToken, {
    apiUrl: serverEnv.apiUrl,
    apiKey,
    revalidateSeconds: serverEnv.configRevalidateSeconds,
  });

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new StorefrontApiError(`Storefront API unreachable: ${(err as Error).message}`);
  }

  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) throw new StorefrontApiError(`Storefront API responded ${res.status}`, res.status);

  const body: unknown = await res.json().catch(() => null);
  const parsed = z.object({ data: StorefrontConfigSchema }).safeParse(body);
  if (!parsed.success) throw new StorefrontApiError('Storefront API returned an invalid config payload');
  const config = parsed.data.data;
  // Preview can only be granted for a request that actually carried a token (defence in depth).
  return { status: 'found', config: { ...config, preview: previewToken !== null && config.preview } };
}

/**
 * Server-side store config lookup for a normalized host (+ optional preview token). Deduplicated
 * per request (React cache). Public lookups are cached under tag `store:{host}`; preview lookups
 * bypass the shared cache entirely (see buildConfigRequest).
 */
export const getStorefrontConfig = cache(fetchStorefrontConfig);
