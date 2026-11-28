import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import type { SocialLinks, StoreContact, StorefrontCommerce, StorefrontConfig, StorefrontInboxConfig, StorefrontMedia } from '@storeplix/types';
import { parseCommerce } from './commerce-schemas';
import { parseInboxConfig } from './inbox-schemas';
import { serverEnv } from './env';
import { buildConfigRequest, buildPageIndexRequest, buildPageRequest, type StorefrontRequestInit } from './config-request';
import { buildCommerceRequest } from './commerce-request';
import { normalizeHost } from './host';
import { previewClientIp } from './preview-client-ip';
import { parseRedirectHost } from './primary-host';
import { sanitizeImageUrl } from './sanitize';
import { isSuspendedConfigBody } from './suspended-config';
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
    // Phase 6 (P6-15): primary host to permanently redirect to; optional on the wire. Invalid → null.
    redirect_host: z.unknown().optional().transform(parseRedirectHost),
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
  // Phase 8.8e (PHASE-8-8E §9.1); optional on the wire → null (no widget, no order Messages card).
  inbox: z.unknown().optional().transform(parseInboxConfig),
});

/**
 * Store config whose `theme` is still untrusted input for the theme engine. Optional-on-the-wire
 * fields (icons, contact, social, navigation, media) are always present here, with safe defaults.
 */
export type RawStorefrontConfig = Omit<StorefrontConfig, 'theme' | 'store' | 'contact' | 'social' | 'navigation' | 'media' | 'commerce' | 'inbox'> & {
  commerce: StorefrontCommerce | null;
  /** 8.8e §9.1: null = no widget, no order Messages (always null on a draft store). */
  inbox?: StorefrontInboxConfig | null;
  store: StorefrontConfig['store'] & { icons: NonNullable<StorefrontConfig['store']['icons']> };
  contact: StoreContact;
  social: SocialLinks;
  navigation: StorefrontNavigation;
  media: Record<string, StorefrontMedia>;
  theme?: unknown;
};

/**
 * `/storefront/config` answer (openapi 1.9.0 `StorefrontConfig | StorefrontSuspended`). `suspended` (P8-12): the shop
 * is suspended by Store Plix; render only the bare "temporarily unavailable" page, never its name, theme or contact.
 */
export type StorefrontConfigResult =
  | { status: 'found'; config: RawStorefrontConfig }
  | { status: 'suspended' }
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
  if (isSuspendedConfigBody(body)) return { status: 'suspended' };
  const parsed = z.object({ data: StorefrontConfigSchema }).safeParse(body);
  if (!parsed.success) throw new StorefrontApiError('Storefront API returned an invalid config payload');
  return { status: 'found', config: finalizeConfig(parsed.data.data, host, previewToken) };
}

/**
 * Request-specific fixes on a parsed config: the request host stands in for a
 * missing primary; preview needs a token; a preview or a redirect to the request host itself never
 * redirects (no loops even if the API got it wrong).
 */
function finalizeConfig(
  config: z.infer<typeof StorefrontConfigSchema>,
  host: string,
  previewToken: string | null,
): RawStorefrontConfig {
  // Preview can only be granted for a request that actually carried a token (defence in depth).
  const preview = previewToken !== null && config.preview;
  const redirect = config.store.redirect_host;
  return {
    ...config,
    store: {
      ...config.store,
      primary_host: config.store.primary_host || host,
      redirect_host: preview || redirect === host ? null : redirect,
    },
    preview,
    // 8.8e §9.1: never a widget or order Messages on a draft store, whatever the API sent.
    inbox: config.store.status === 'active' ? config.inbox : null,
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

// ---------- Phase 8.5 unsubscribe (PHASE-8-5 §4.2 / §8.6; WEB owns these two functions) ----------

const UnsubscribeStatusSchema = z.object({
  channel: z.enum(['sms', 'email']),
  masked_address: z.string().max(254),
  status: z.enum(['subscribed', 'unsubscribed']),
  is_test: z.boolean().catch(false),
  store_name: z.string().max(200),
});
export type UnsubscribeView = z.infer<typeof UnsubscribeStatusSchema>;

/** `found` (validated), `invalid` (404 `unsubscribe_link_invalid`, also for malformed codes), or `error` (429/5xx/network). */
export type UnsubscribeResult = { status: 'found'; data: UnsubscribeView } | { status: 'invalid' } | { status: 'error'; code: number };

const UNSUBSCRIBE_CODE = /^[A-Za-z0-9]{10}$/;

async function unsubscribeCall(host: string, code: string, clientIp: string | null, body?: { action: 'unsubscribe' | 'resubscribe'; one_click?: boolean }): Promise<UnsubscribeResult> {
  if (!UNSUBSCRIBE_CODE.test(code)) return { status: 'invalid' };
  const { url, init } = buildCommerceRequest(`/storefront/unsubscribe/${code}`, host, { cache: { kind: 'no-store' }, method: body ? 'POST' : 'GET', body, clientIp }, { apiUrl: serverEnv.apiUrl, apiKey: requireApiKey() });
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Never log the code: path prefix and message only.
    console.error(`[storefront] unsubscribe ${body ? 'POST' : 'GET'} failed: ${(err as Error).message}`);
    return { status: 'error', code: 0 };
  }
  if (res.status === 404) return { status: 'invalid' };
  if (!res.ok) return { status: 'error', code: res.status };
  const parsed = z.object({ data: UnsubscribeStatusSchema }).safeParse(await res.json().catch(() => null));
  return parsed.success ? { status: 'found', data: parsed.data.data } : { status: 'error', code: 502 };
}

/** GET /storefront/unsubscribe/{code}: never changes state (link scanners, SMS previewers; S116). */
export function getUnsubscribeStatus(host: string, code: string, clientIp: string | null): Promise<UnsubscribeResult> {
  return unsubscribeCall(host, code, clientIp);
}

/** POST /storefront/unsubscribe/{code}: idempotent; a test code answers `is_test: true` and changes nothing. */
export function postUnsubscribe(host: string, code: string, action: 'unsubscribe' | 'resubscribe', clientIp: string | null, oneClick = false): Promise<UnsubscribeResult> {
  return unsubscribeCall(host, code, clientIp, oneClick ? { action, one_click: true } : { action });
}
