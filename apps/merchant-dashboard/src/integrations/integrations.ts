import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import {
  GA4_MEASUREMENT_ID_PATTERN,
  GTM_CONTAINER_ID_PATTERN,
  looksLikePastedCode,
  META_PIXEL_ID_PATTERN,
  TIKTOK_PIXEL_ID_PATTERN,
  TRACKING_EVENT_NAMES,
  type CatalogReviewStatus,
  type CatalogSyncRun,
  type FeedProvider,
  type IntegrationAttention,
  type IntegrationCheckState,
  type IntegrationOauthErrorReason,
  type IntegrationProvider,
  type PurchaseTrigger,
  type StoreIntegrationStatus,
  type TrackingEventLogEntry,
  type TrackingEventName,
  type TrackingProvider,
} from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { errorMessage } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';
import { hasPermission, type PermissionHolder } from '../lib/permissions';

// PHASE-8-9D §8 part A (WEB): pure helpers for the tracking and product-feed integration pages. Figma `32:5331`
// (2132:53511 GA4, 2133:53731/2140:58094 TikTok, 2133:54292/2140:58941 GTM, 28:2152/2134:64916/2139:56806/2139:57369
// Meta, 2134:65506/2141:57154 catalog, 2134:66100 Google Merchant). Rule 7: IDs and tokens only.

export type PartAProvider = TrackingProvider | FeedProvider;

/** Figma routes (§8) ↔ `IntegrationProvider` values. */
export const SLUG_BY_PROVIDER: Record<PartAProvider, string> = {
  meta_pixel: 'meta-pixel',
  ga4: 'ga4',
  tiktok_pixel: 'tiktok',
  gtm_server: 'gtm',
  meta_catalog: 'meta-catalog',
  google_merchant: 'google-merchant',
};
export const PROVIDER_BY_SLUG: Record<string, PartAProvider> = Object.fromEntries(Object.entries(SLUG_BY_PROVIDER).map(([p, s]) => [s, p as PartAProvider]));
export const integrationPath = (p: PartAProvider) => `/integrations/${SLUG_BY_PROVIDER[p]}`;

export const PIXEL_PROVIDERS = ['meta_pixel', 'ga4', 'tiktok_pixel'] as const;
export type PixelProvider = (typeof PIXEL_PROVIDERS)[number];
export const isPixel = (p: IntegrationProvider): p is PixelProvider => (PIXEL_PROVIDERS as readonly string[]).includes(p);
export const isFeed = (p: IntegrationProvider): p is FeedProvider => p === 'meta_catalog' || p === 'google_merchant';

export interface ProviderMeta {
  name: string;
  short: string;
  group: 'Marketing & tracking' | 'Sales channels';
  groupFilter: 'tracking' | 'channels';
  typePill: string;
  description: string;
  /** Integrations list card line when the API sends no `summary`. */
  capability: string;
  externalLabel: string;
  externalUrl: string;
  /** "Pixel ID" etc. — used in the pasted-code message. */
  idLabel: string;
  tip: { title: string; body: string };
}

export const PROVIDER_META: Record<PartAProvider, ProviderMeta> = {
  meta_pixel: {
    name: 'Meta Pixel + Conversions API',
    short: 'Meta',
    group: 'Marketing & tracking',
    groupFilter: 'tracking',
    typePill: 'Ad tracking',
    description: 'Send shop events to Facebook and Instagram ads from the browser and from our server, so ads keep working when cookies are blocked.',
    capability: 'Browser + server events, deduplicated',
    externalLabel: 'Open Meta panel',
    externalUrl: 'https://business.facebook.com/events_manager2',
    idLabel: 'Pixel ID',
    tip: { title: 'IDs only, no code box', body: 'Storeplix loads Meta’s official pixel itself with your Pixel ID. Pixel base code and scripts are never accepted.' },
  },
  ga4: {
    name: 'Google Analytics 4',
    short: 'GA4',
    group: 'Marketing & tracking',
    groupFilter: 'tracking',
    typePill: 'Analytics',
    description: 'See where shoppers come from and what they buy. Storeplix loads Google’s official tag with your Measurement ID and sends purchases from our server — you paste IDs, never code.',
    capability: 'Ecommerce events',
    externalLabel: 'Open Google Analytics',
    externalUrl: 'https://analytics.google.com/',
    idLabel: 'Measurement ID',
    tip: { title: 'IDs only, no code box', body: 'For your shoppers’ safety Storeplix never runs code pasted by a shop. Tracking connects with IDs and tokens only, and Storeplix loads Google’s official tag itself.' },
  },
  tiktok_pixel: {
    name: 'TikTok Pixel + Events API',
    short: 'TikTok',
    group: 'Marketing & tracking',
    groupFilter: 'tracking',
    typePill: 'Ad tracking',
    description: 'Send shop events to TikTok Ads from the browser and from our server, so your ads learn who actually buys. Storeplix loads TikTok’s official pixel with your Pixel ID — you paste IDs, never code.',
    capability: 'Browser + server events',
    externalLabel: 'Open TikTok Events Manager',
    externalUrl: 'https://ads.tiktok.com/i18n/events_manager',
    idLabel: 'Pixel ID',
    tip: { title: 'IDs only, no code box', body: 'For your shoppers’ safety Storeplix never runs code pasted by a shop. TikTok connects with a Pixel ID and token only, and Storeplix loads TikTok’s official pixel itself.' },
  },
  gtm_server: {
    name: 'Google Tag Manager',
    short: 'GTM',
    group: 'Marketing & tracking',
    groupFilter: 'tracking',
    typePill: 'Server-side',
    description: 'Forward your shop’s events to your own server-side Tag Manager container. Storeplix sends them from our server, so tags in your container run on your server — never in your shoppers’ browsers.',
    capability: 'Your own tags, server-side',
    externalLabel: 'Open Tag Manager',
    externalUrl: 'https://tagmanager.google.com/',
    idLabel: 'Server container ID',
    tip: { title: 'Server-side only', body: 'Your server container decides where events go next (GA4, Meta, TikTok). Storeplix only sends events; it never loads your container’s scripts on the shop.' },
  },
  meta_catalog: {
    name: 'Facebook & Instagram catalog',
    short: 'Meta catalog',
    group: 'Sales channels',
    groupFilter: 'channels',
    typePill: 'Product feed',
    description: 'Keep a Meta catalog in sync with your products, so you can tag products in Instagram posts and run catalog ads. Shoppers who tap a product land on your shop to order.',
    capability: 'Product feed for Facebook Shops, Instagram product tags and catalog ads',
    externalLabel: 'Open Commerce Manager',
    externalUrl: 'https://business.facebook.com/commerce',
    idLabel: 'Catalog ID',
    tip: { title: 'Orders stay on your shop', body: 'Checkout never moves to Facebook: COD, bKash, fraud checks and couriers work as usual.' },
  },
  google_merchant: {
    name: 'Google Merchant Center',
    short: 'Google',
    group: 'Sales channels',
    groupFilter: 'channels',
    typePill: 'Product feed',
    description: 'Show your products free on Google Shopping, Search, Images and YouTube, and use them in Performance Max ads. Storeplix keeps the product feed up to date.',
    capability: 'Free listings and Shopping ads on Google, from the same product feed',
    externalLabel: 'Open Merchant Center',
    externalUrl: 'https://merchants.google.com/',
    idLabel: 'Merchant Center ID',
    tip: { title: 'Verification without code', body: 'Google’s site check uses a meta tag. Storeplix adds it to your shop’s page head itself; you never paste HTML or scripts.' },
  },
};

export const TRACKING_ORDER: TrackingProvider[] = ['meta_pixel', 'tiktok_pixel', 'ga4', 'gtm_server'];
export const FEED_ORDER: FeedProvider[] = ['meta_catalog', 'google_merchant'];

// ---------- Permissions (P89D-41, P89D-42) ----------

/** Reads: `integrations.manage | marketing.manage`. Staff never see tracking or feeds. */
export const canViewIntegrations = (m: PermissionHolder) => hasPermission(m, 'integrations.manage') || hasPermission(m, 'marketing.manage');
/** Writes, OAuth, tests, sync now, disconnect: `integrations.manage` (impersonation is read-only on top). */
export const canManageIntegrations = (m: PermissionHolder) => hasPermission(m, 'integrations.manage');

// ---------- Status ----------

export function statusMeta(status: StoreIntegrationStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'connected':
      return { label: 'Connected', tone: 'success' };
    case 'needs_attention':
      return { label: 'Needs attention', tone: 'warning' };
    case 'error':
      return { label: 'Not working', tone: 'danger' };
    case 'setup_required':
      return { label: 'Finish setup', tone: 'warning' };
    default:
      return { label: 'Not connected', tone: 'neutral' };
  }
}

/** Has a working (or fixable) connection: show the tabs, not the connect flow. */
export const isLive = (s: StoreIntegrationStatus) => s === 'connected' || s === 'needs_attention' || s === 'error';

export function attentionText(a: IntegrationAttention, provider: PartAProvider): string {
  const n = a.count ?? 0;
  switch (a.reason) {
    case 'token_invalid':
      return provider === 'meta_catalog' || provider === 'google_merchant' ? 'Access stopped working. Reconnect to keep syncing.' : 'The access token stopped working. Replace it on the Overview tab.';
    case 'token_expiring':
      return 'Access expires soon. Reconnect to keep syncing.';
    case 'token_expired':
      return 'Access expired. Reconnect to keep syncing.';
    case 'setup_incomplete':
      return 'Setup isn’t finished yet.';
    case 'website_not_claimed':
      return 'Website not claimed yet. Google shows products only after your shop address is verified.';
    case 'store_not_live':
      return 'Your shop isn’t published yet (Coming soon).';
    case 'items_with_issues':
      return `${n.toLocaleString('en-US')} ${n === 1 ? 'product has' : 'products have'} issues — fix them in the product editor.`;
    case 'plan_required':
      return 'Paused: your plan doesn’t include this. Upgrade to turn it back on.';
    case 'endpoint_unreachable':
      return 'We couldn’t reach your tagging server. Check the URL.';
    case 'delivery_failing':
      return 'Many recent events failed to deliver. Check the event log.';
  }
}

export const featureName: Record<'product_feeds' | 'server_side_tagging', string> = {
  product_feeds: 'Product feeds',
  server_side_tagging: 'Server-side tagging',
};
export const featurePlan: Record<'product_feeds' | 'server_side_tagging', string> = { product_feeds: 'Starter', server_side_tagging: 'Growth' };

// ---------- IDs (P89D-6) ----------

const ID_PATTERN: Record<PixelProvider | 'gtm_server', RegExp> = {
  meta_pixel: META_PIXEL_ID_PATTERN,
  ga4: GA4_MEASUREMENT_ID_PATTERN,
  tiktok_pixel: TIKTOK_PIXEL_ID_PATTERN,
  gtm_server: GTM_CONTAINER_ID_PATTERN,
};
const ID_EXAMPLE: Record<PixelProvider | 'gtm_server', string> = {
  meta_pixel: '128455670912334',
  ga4: 'G-7K2QX9M4LP',
  tiktok_pixel: 'CQ8H2JRC77U0B1M3N4K0',
  gtm_server: 'GTM-W8K3PZ5',
};
const ID_HINT: Record<PixelProvider | 'gtm_server', string> = {
  meta_pixel: 'Pixel IDs are 10–20 digits.',
  ga4: 'Measurement IDs start with G-.',
  tiktok_pixel: 'Pixel IDs are 20 letters and numbers.',
  gtm_server: 'Container IDs start with GTM-.',
};

/** Trim and upper-case the formats that are upper case (the API does the same). */
export function normalizeId(p: PixelProvider | 'gtm_server', raw: string): string {
  const v = raw.trim();
  return p === 'meta_pixel' ? v : v.toUpperCase();
}

export const pastedCodeMessage = (label: string, example: string) => `This looks like code. Paste only the ${label} — e.g. ${example}.`;

/** Client-side check before PUT (the API re-validates: 422 `integration_code_pasted` / `integration_id_invalid`). */
export function idProblem(p: PixelProvider | 'gtm_server', raw: string): string | null {
  const v = raw.trim();
  const label = PROVIDER_META[p].idLabel;
  if (!v) return `Enter your ${label}.`;
  if (looksLikePastedCode(v)) return p === 'gtm_server' ? 'This is a web container (gtm.js). Use a server container.' : pastedCodeMessage(label, ID_EXAMPLE[p]);
  if (!ID_PATTERN[p].test(normalizeId(p, v))) return `That isn’t a ${label}. ${ID_HINT[p]} e.g. ${ID_EXAMPLE[p]}.`;
  return null;
}

export const TEST_CODE_PATTERN = /^[A-Za-z0-9]{4,32}$/;
export function testCodeProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (looksLikePastedCode(v)) return pastedCodeMessage('test event code', 'TEST12345');
  return TEST_CODE_PATTERN.test(v) ? null : 'Test event codes are 4–32 letters and numbers, e.g. TEST12345.';
}

export function secretProblem(raw: string, label: string): string | null {
  const v = raw.trim();
  if (!v) return `Paste the ${label}.`;
  if (looksLikePastedCode(v)) return `This looks like code. Paste only the ${label}.`;
  if (/\s/.test(v)) return `The ${label} has no spaces. Copy it again.`;
  return null;
}

/** GTM tagging server URL (P89D-17): https, port 443, a host name (not an IP), never a web container. */
export function taggingUrlProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter your tagging server URL.';
  if (/gtm\.js|googletagmanager\.com/i.test(v) || looksLikePastedCode(v)) return 'This is a web container (gtm.js). Paste your server container’s tagging server URL, e.g. https://sgtm.yourshop.com.';
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return 'Use an https:// address, e.g. https://sgtm.yourshop.com.';
  }
  if (url.protocol !== 'https:') return 'Use an https:// address.';
  if (url.port && url.port !== '443') return 'Use the standard https port (443).';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':') || url.hostname.startsWith('[')) return 'Use your own domain or subdomain, not an IP address.';
  if (!url.hostname.includes('.') || /\.(local|localhost|internal|lan)$/i.test(url.hostname) || url.hostname === 'localhost') return 'Use your own public domain or subdomain.';
  return null;
}

export interface UrlCheckRow {
  label: string;
  state: IntegrationCheckState;
}
/** The four check rows on the GTM URL error frame (2140:58941); the reachability check runs on the server. */
export function taggingUrlChecks(raw: string): UrlCheckRow[] {
  const v = raw.trim();
  let url: URL | null;
  try {
    url = new URL(v);
  } catch {
    url = null;
  }
  const https = !!url && url.protocol === 'https:';
  const notWeb = !!v && !/gtm\.js|googletagmanager\.com/i.test(v) && !looksLikePastedCode(v);
  const ownDomain = !!url && url.hostname.includes('.') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) && !/googletagmanager\.com$/i.test(url.hostname);
  return [
    { label: 'Starts with https://', state: https ? 'ok' : 'fail' },
    { label: 'Not a web container', state: notWeb ? 'ok' : 'fail' },
    { label: 'Your own domain or subdomain', state: ownDomain ? 'ok' : 'fail' },
    { label: 'Answers /healthy within 5 s', state: 'skipped' },
  ];
}

// ---------- Secrets (P89D-7) ----------

/** "••••3fQa" from the API hint (already masked); never a secret. */
export const maskedHint = (hint: string | undefined) => (hint ? (hint.startsWith('•') ? hint : `••••${hint.slice(-4)}`) : null);

// ---------- Events (§5) ----------

export const purchaseTriggerLabel: Record<PurchaseTrigger, string> = {
  order_placed: 'Order is placed',
  order_confirmed: 'Order is confirmed',
  order_delivered: 'Order is delivered',
};

export const eventWhen: Record<TrackingEventName, string> = {
  page_view: 'Every page',
  view_item: 'Product page opened',
  add_to_cart: 'Added to cart or order form',
  begin_checkout: 'Phone number entered',
  purchase: 'Order confirmed (your choice)',
  refund: 'Order returned or refunded',
};

/** Provider name for an event, or the canonical name; null when the provider gets no such event. */
export const providerEventName = (p: TrackingProvider, e: TrackingEventName) => TRACKING_EVENT_NAMES[p][e];

/** Events shown in the "Events we’ll send" / stats tables, in funnel order, for that provider. */
export function providerEvents(p: TrackingProvider): TrackingEventName[] {
  const all: TrackingEventName[] = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];
  return all.filter((e) => TRACKING_EVENT_NAMES[p][e] !== null);
}

export function sentFrom(p: TrackingProvider, e: TrackingEventName, mirror: boolean): string {
  if (e === 'purchase' || e === 'refund' || p === 'gtm_server') return 'Server';
  if (p === 'ga4') return 'Browser';
  return mirror ? 'Browser + server' : 'Browser';
}

export function eventStatusMeta(e: Pick<TrackingEventLogEntry, 'status' | 'attempts' | 'max_attempts' | 'deduplicated' | 'skip_reason'>): { label: string; tone: BadgeTone } {
  switch (e.status) {
    case 'delivered':
      return e.deduplicated ? { label: 'Deduplicated', tone: 'info' } : { label: 'Delivered', tone: 'success' };
    case 'retrying':
      return { label: `Retrying · ${e.attempts} of ${e.max_attempts}`, tone: 'warning' };
    case 'pending':
      return { label: 'Queued', tone: 'neutral' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    case 'skipped':
      return { label: e.skip_reason === 'no_consent' ? 'Skipped · no consent' : 'Skipped', tone: 'neutral' };
  }
}

export function eventErrorText(e: Pick<TrackingEventLogEntry, 'error_code' | 'http_status' | 'status' | 'attempts' | 'max_attempts' | 'skip_reason'>): string | null {
  if (e.status === 'skipped') {
    switch (e.skip_reason) {
      case 'no_consent':
        return 'Not sent: the shopper declined cookies.';
      case 'no_token':
        return 'Not sent: the access token isn’t working. Replace it on the Overview tab.';
      case 'plan_required':
        return 'Not sent: your plan doesn’t include this integration.';
      case 'disabled':
        return 'Not sent: the integration was disconnected.';
      default:
        return null;
    }
  }
  if (!e.error_code) return null;
  const http = e.http_status ? ` (HTTP ${e.http_status})` : '';
  const retry = e.status === 'retrying' ? ` Retrying ${e.attempts} of ${e.max_attempts}.` : '';
  switch (e.error_code) {
    case 'auth':
      return `The access token was rejected${http}. Replace the token on the Overview tab.`;
    case 'rate_limited':
      return `Rate limited by the platform${http}.${retry}`;
    case 'rejected':
      return `The platform rejected the event${http}.${retry}`;
    case 'timeout':
      return `No answer in time.${retry}`;
    case 'endpoint_blocked':
      return 'Your tagging server URL is blocked. Fix the URL in Overview.';
    default:
      return `The platform didn’t answer${http}.${retry}`;
  }
}

export const deliveryRate = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(rate >= 0.995 && rate < 1 ? 1 : rate === 1 ? 0 : 1)}%`);

export const timeOfDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// ---------- Feeds (§7) ----------

export const syncKindLabel: Record<CatalogSyncRun['kind'], string> = { full: 'Full sync', delta: 'Update', manual: 'Sync now' };
export const syncTriggerLabel: Record<CatalogSyncRun['trigger'], string> = {
  schedule: 'Scheduled',
  price_change: 'Price change',
  stock_change: 'Stock change',
  product_change: 'Product change',
  manual: 'Sync now',
  connect: 'First sync',
};
export function syncStatusMeta(s: CatalogSyncRun['status']): { label: string; tone: BadgeTone } {
  switch (s) {
    case 'running':
      return { label: 'Running', tone: 'info' };
    case 'done':
      return { label: 'Done', tone: 'success' };
    case 'partial':
      return { label: 'Partly done', tone: 'warning' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
  }
}
export function syncResult(r: CatalogSyncRun): string {
  if (r.status === 'running') return 'In progress…';
  if (r.status === 'failed') return r.error_code ? `Failed · ${r.error_code.replace(/_/g, ' ')}` : 'Failed';
  const parts = [`${r.items_sent.toLocaleString('en-US')} updated`];
  if (r.items_failed) parts.push(`${r.items_failed} with issues`);
  if (r.items_deleted) parts.push(`${r.items_deleted} removed`);
  return parts.join(' · ');
}

export function reviewMeta(r: CatalogReviewStatus | null): { label: string; tone: BadgeTone } {
  switch (r) {
    case 'approved':
      return { label: 'Approved', tone: 'success' };
    case 'in_review':
      return { label: 'In review', tone: 'info' };
    case 'limited':
      return { label: 'Limited reach', tone: 'warning' };
    case 'disapproved':
      return { label: 'Disapproved', tone: 'danger' };
    default:
      return { label: 'Not sent', tone: 'neutral' };
  }
}

export const excludedReasonLabel = {
  not_published: 'Not published',
  no_image: 'No image',
  no_price: 'No price',
  sold_out_hidden: 'Sold out (hidden)',
  category_filtered: 'Category not included',
  archived: 'Archived',
} as const;

export const oauthErrorText: Record<IntegrationOauthErrorReason, string> = {
  denied: 'You cancelled the sign-in, so nothing was connected.',
  state_invalid: 'That sign-in link expired. Start again.',
  exchange_failed: 'We couldn’t finish signing in. Try again.',
  missing_permission: 'Some permissions were not granted. Connect again and allow every permission.',
  provider_unavailable: 'The platform didn’t answer. Try again in a few minutes.',
};
export const isOauthReason = (r: string | null): r is IntegrationOauthErrorReason => !!r && r in oauthErrorText;

/** Only follow https authorize URLs (the API builds them from config). */
export const isSafeAuthorizeUrl = (url: string) => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

// ---------- Errors (§13.2) ----------

const fieldOf = (e: { details?: Record<string, unknown> }) => (typeof e.details?.field === 'string' ? e.details.field : null);

export function integrationErrorText(error: unknown, provider?: PartAProvider, fallback = 'Something went wrong. Try again.'): string {
  if (isImpersonationReadOnly(error)) return READ_ONLY_MESSAGE;
  if (!isApiError(error)) return errorMessage(error, fallback);
  const label = provider ? PROVIDER_META[provider].idLabel : 'ID';
  switch (error.code) {
    case 'integration_code_pasted':
      return provider === 'gtm_server' ? 'This is a web container (gtm.js). Use a server container.' : `This looks like code. Paste only the ${fieldOf(error) === 'test_event_code' ? 'test event code' : label}.`;
    case 'integration_id_invalid':
      return `That ${fieldOf(error) === 'test_event_code' ? 'test event code' : label} isn’t valid. Check it and try again.`;
    case 'integration_credentials_invalid':
      return 'The platform didn’t accept that token. Copy a new one and try again.';
    case 'integration_endpoint_blocked':
      return 'We can’t send to that address. Use your own https:// domain that answers within 5 s.';
    case 'integration_setup_required':
      return 'Finish connecting first.';
    case 'integration_not_connected':
      return 'This integration isn’t connected.';
    case 'confirmation_mismatch':
      return 'Type DISCONNECT in capital letters to confirm.';
    case 'store_not_live':
      return 'Publish your shop first — Google can’t verify a Coming soon page.';
    case 'feed_sync_in_progress':
      return 'A sync is already running. It usually finishes in a few minutes.';
    case 'website_claim_failed': {
      const step = typeof error.details?.step === 'string' ? error.details.step : null;
      if (step === 'token') return 'Google didn’t give us a verification tag. Try again in a minute.';
      if (step === 'verify') return 'Google couldn’t verify your shop yet. Wait a few minutes after publishing, then try again.';
      if (step === 'claim') return 'Your website is verified, but another Merchant Center account has claimed it.';
      return 'Google couldn’t claim your website. Try again.';
    }
    case 'tracking_test_failed':
      return 'The test event wasn’t accepted. See the details below.';
    case 'feature_not_in_plan':
      return 'Your plan doesn’t include this. Upgrade to use it.';
    case 'revision_conflict':
      return 'Someone else changed these settings. We loaded the latest version — try again.';
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.';
    case 'provider_unavailable':
      return 'The platform didn’t answer. Try again in a few minutes.';
    default:
      return error.message || fallback;
  }
}

/** The field (`details.field`) a 422 points at, mapped to our form keys. */
export const errorField = (error: unknown): string | null => (isApiError(error) && (error.code === 'integration_code_pasted' || error.code === 'integration_id_invalid') ? fieldOf(error) : null);

// ---------- Tabs ----------

/** Pixels (§8, Q365): Overview (IDs, token and tracking settings folded in) · Event log · Test & verify. */
export type PixelTab = 'overview' | 'events' | 'test';
export type GtmTab = 'overview' | 'log' | 'settings';
export type FeedTab = 'overview' | 'products' | 'history' | 'settings';
export const PIXEL_TABS: PixelTab[] = ['overview', 'events', 'test'];
export const GTM_TABS: GtmTab[] = ['overview', 'log', 'settings'];
export const FEED_TABS: FeedTab[] = ['overview', 'products', 'history', 'settings'];
export const PIXEL_TAB_LABELS: Record<PixelTab, string> = { overview: 'Overview', events: 'Event log', test: 'Test & verify' };
/** Figma deep links: `?tab=test-events` (2134:64916) → Test & verify; `?tab=settings` (2139:57369) → Overview (Q365). */
export const pixelTabFromParam = (raw: string | null): PixelTab => parseTab<PixelTab>(raw === 'test-events' ? 'test' : raw === 'settings' ? 'overview' : raw, PIXEL_TABS);
export const GTM_TAB_LABELS: Record<GtmTab, string> = { overview: 'Overview', log: 'Forwarding log', settings: 'Settings' };
export const FEED_TAB_LABELS: Record<FeedTab, string> = { overview: 'Overview', products: 'Products', history: 'Sync history', settings: 'Settings' };
export function parseTab<T extends string>(raw: string | null, tabs: readonly T[]): T {
  return raw && (tabs as readonly string[]).includes(raw) ? (raw as T) : tabs[0]!;
}
