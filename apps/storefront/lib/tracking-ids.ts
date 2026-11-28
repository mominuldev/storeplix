import {
  GA4_MEASUREMENT_ID_PATTERN,
  GOOGLE_SITE_VERIFICATION_PATTERN,
  META_PIXEL_ID_PATTERN,
  TIKTOK_PIXEL_ID_PATTERN,
  TRACKING_SCRIPT_HOSTS,
} from '@storeplix/types';

/**
 * PHASE-8-9D §6.1, P89D-8, S331 (rule 7): the only merchant value that reaches a tracking tag is a pixel ID, and only
 * after it matched the shared `packages/types` pattern here. Pure and client-safe. Anything else (pasted snippets,
 * quotes, `</script>`, whitespace, unicode look-alikes) is rejected → that tag simply isn't loaded. IDs never enter
 * script text: the loaders (components/tracking) are fixed code that receives the ID as a function argument, and the
 * vendor script URL carries it URL-encoded.
 */

export type BrowserPixel = 'meta_pixel' | 'ga4' | 'tiktok_pixel';

const PATTERNS: Record<BrowserPixel, RegExp> = {
  meta_pixel: META_PIXEL_ID_PATTERN,
  ga4: GA4_MEASUREMENT_ID_PATTERN,
  tiktok_pixel: TIKTOK_PIXEL_ID_PATTERN,
};

/** The ID when it is a string that fully matches the provider pattern; otherwise null. */
export function validPixelId(provider: BrowserPixel, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  return PATTERNS[provider].test(value) ? value : null;
}

export function validSiteVerification(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  return GOOGLE_SITE_VERIFICATION_PATTERN.test(value) ? value : null;
}

/**
 * Official loader URLs (fixed Storeplix templates on the T47 hosts). The ID is validated, then URL-encoded. GA4 loads
 * `gtag/js` — never `gtm.js` (P89D-9: no web container).
 */
export function pixelScriptUrl(provider: BrowserPixel, value: unknown): string | null {
  const id = validPixelId(provider, value);
  if (id === null) return null;
  const q = encodeURIComponent(id);
  switch (provider) {
    case 'meta_pixel':
      return `${TRACKING_SCRIPT_HOSTS.meta_pixel[0]}/en_US/fbevents.js`;
    case 'ga4':
      return `${TRACKING_SCRIPT_HOSTS.ga4[0]}/gtag/js?id=${q}`;
    case 'tiktok_pixel':
      return `${TRACKING_SCRIPT_HOSTS.tiktok_pixel[0]}/i18n/pixel/events.js?sdkid=${q}&lib=ttq`;
  }
}
