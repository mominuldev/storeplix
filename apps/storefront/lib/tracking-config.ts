import type { StorefrontTrackingConfig } from '@storeplix/types';
import type { StoreMode } from './store-mode';
import { validPixelId, validSiteVerification } from './tracking-ids';

/**
 * `StorefrontConfig.tracking` at the boundary (PHASE-8-9D §6.1, P89D-22, S333). Pure. Only the allowed fields are kept;
 * every ID is re-validated with the shared patterns (an invalid one becomes null, the rest still work). Absent,
 * malformed or non-object → null: no tag, no beacon, no consent bar (P89D-2).
 */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseTrackingConfig(v: unknown): StorefrontTrackingConfig | null {
  if (!isObject(v)) return null;
  const sv = isObject(v.site_verification) ? v.site_verification : {};
  const currency = typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? v.currency : 'BDT';
  return {
    meta_pixel_id: validPixelId('meta_pixel', v.meta_pixel_id),
    ga4_measurement_id: validPixelId('ga4', v.ga4_measurement_id),
    tiktok_pixel_id: validPixelId('tiktok_pixel', v.tiktok_pixel_id),
    // Unknown → wait: when in doubt, ask before tracking.
    wait_for_consent: typeof v.wait_for_consent === 'boolean' ? v.wait_for_consent : true,
    collect: v.collect !== false,
    currency,
    site_verification: { google: validSiteVerification(sv.google) },
  };
}

/** Tracking only ever runs on a live (public, active) render — never Coming soon or preview (§6.1, S333). */
export function liveTracking(mode: StoreMode, tracking: StorefrontTrackingConfig | null | undefined): StorefrontTrackingConfig | null {
  return mode === 'live' && tracking ? tracking : null;
}

/** Anything to run in the browser: a base tag or the beacon (GTM server receives beacon events via the API). */
export function hasBrowserTracking(t: StorefrontTrackingConfig): boolean {
  return Boolean(t.meta_pixel_id || t.ga4_measurement_id || t.tiktok_pixel_id || t.collect);
}
