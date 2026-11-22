import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import type { SocialLinks, StoreContact, StorefrontCommerce, StorefrontConfig, StorefrontMedia } from '@storeplix/types';
import { parseCommerce } from './commerce-schemas';
import { serverEnv } from './env';
import { buildConfigRequest, buildPageIndexRequest, buildPageRequest, type StorefrontRequestInit } from './config-request';
import { normalizeHost } from './host';
import { previewClientIp } from './preview-client-ip';
import { sanitizeImageUrl } from './sanitize';
import {
  isPageSlug,
  parseMediaMap,
  parseNavigation,
  parsePageIndex,
  parseStorefrontPage,
  type SafeStorefrontPage,
  type StorefrontNavigation,
} from './storefront-schemas';

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Missing or malformed object -> `{}` so every nullable field defaults to null (rolling deploys). */
const nullableObject = <S extends z.ZodRawShape>(shape: S) => z.preprocess((v) => (isObject(v) ? v : {}), z.object(shape));
const nullableString = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);

/**
 * Render-only store data validated at the boundary. `theme` is validated later by the theme engine.
 * Contact/social values are only length-checked here; links are built and validated at render
 * (lib/contact.ts) so an unsafe value simply isn't rendered. Phase 3 fields (primary_host, seo
 * og_image_url/noindex, navigation, media) are optional on the wire and default safely.
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
    // Canonical host; '' = unknown (the request host is used instead).
    primary_host: z.preprocess((v) => normalizeHost(typeof v === 'string' ? v : null) ?? '', z.string()),
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
  seo: z.preprocess(
    (v) => (isObject(v) ? v : {}),
    z.object({
      title: z.string().max(300).catch(''),
      description: z.string().max(1000).nullable().catch(null),
      og_image_url: z.preprocess((v) => sanitizeImageUrl(v), z.string().nullable()),
      noindex: z.boolean().catch(false),
    }),
  ),
  navigation: z.unknown().optional().transform(parseNavigation),
  media: z.unknown().optional().transform(parseMediaMap),
  // Phase 5a; optional on the wire (rolling deploys) → null.
  commerce: z.unknown().optional().transform(parseCommerce),
});

/**
 * Store config whose `theme` is still untrusted input for the theme engine. Optional-on-the-wire
 * fields (icons, contact, social, navigation, media) are always present here, with safe defaults.
 */
export type RawStorefrontConfig = Omit<StorefrontConfig, 'theme' | 'store' | 'contact' | 'social' | 'navigation' | 'media' | 'commerce'> & {
  commerce: StorefrontCommerce | null;
  store: StorefrontConfig['store'] & { icons: NonNullable<StorefrontConfig['store']['icons']> };
  contact: StoreContact;
  social: SocialLinks;
  navigation: StorefrontNavigation;
  media: Record<string, StorefrontMedia>;
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

function requireApiKey(): string {
  const apiKey = serverEnv.apiKey;
  if (!apiKey) throw new StorefrontApiError('STOREFRONT_API_KEY is not configured');
  return apiKey;
}

async function send(url: string, init: StorefrontRequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new StorefrontApiError(`Storefront API unreachable: ${(err as Error).message}`);
  }
}

async function fetchStorefrontConfig(host: string, previewToken: string | null): Promise<StorefrontConfigResult> {
  const { url, init } = buildConfigRequest(host, previewToken, {
    apiUrl: serverEnv.apiUrl,
    apiKey: requireApiKey(),
    revalidateSeconds: serverEnv.configRevalidateSeconds,
  }, await previewClientIp(previewToken));

  const res = await send(url, init);
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) throw new StorefrontApiError(`Storefront API responded ${res.status}`, res.status);

  const body: unknown = await res.json().catch(() => null);
  const parsed = z.object({ data: StorefrontConfigSchema }).safeParse(body);
  if (!parsed.success) throw new StorefrontApiError('Storefront API returned an invalid config payload');
  const config = parsed.data.data;
  return {
    status: 'found',
    config: {
      ...config,
      store: { ...config.store, primary_host: config.store.primary_host || host },
      // Preview can only be granted for a request that actually carried a token (defence in depth).
      preview: previewToken !== null && config.preview,
    },
  };
}

/**
 * Server-side store config lookup for a normalized host (+ optional preview token). Deduplicated
 * per request (React cache). Public lookups are cached under tag `store:{host}`; preview lookups
 * bypass the shared cache entirely (see buildStorefrontRequest).
 */
export const getStorefrontConfig = cache(fetchStorefrontConfig);

/**
 * `/storefront/pages/{slug}`: a page, or null for 404 / invalid slug / unusable payload. Public:
 * published pages only (API rule); with a valid preview token drafts and hidden pages too.
 */
async function fetchStorefrontPage(host: string, slug: string, previewToken: string | null): Promise<SafeStorefrontPage | null> {
  if (!isPageSlug(slug)) return null;
  const { url, init } = buildPageRequest(host, slug, previewToken, { apiUrl: serverEnv.apiUrl, apiKey: requireApiKey() }, await previewClientIp(previewToken));
  const res = await send(url, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new StorefrontApiError(`Storefront API responded ${res.status}`, res.status);
  const body: unknown = await res.json().catch(() => null);
  const page = parseStorefrontPage(isObject(body) ? (body as { data?: unknown }).data : null);
  if (!page) console.error(`[storefront] unusable page payload for ${host}/pages/${slug}`);
  return page;
}

export const getStorefrontPage = cache(fetchStorefrontPage);

/**
 * Published pages for the sitemap. Never fails the sitemap: an API error or an endpoint that does
 * not exist yet (rolling deploy) yields an empty list.
 */
export async function getStorefrontPageIndex(host: string): Promise<Array<{ slug: string; updated_at: string | null }>> {
  try {
    const { url, init } = buildPageIndexRequest(host, { apiUrl: serverEnv.apiUrl, apiKey: requireApiKey() });
    const res = await send(url, init);
    if (!res.ok) return [];
    const body: unknown = await res.json().catch(() => null);
    return parsePageIndex(isObject(body) ? (body as { data?: unknown }).data : null);
  } catch (err) {
    console.error('[storefront] page index unavailable:', (err as Error).message);
    return [];
  }
}
