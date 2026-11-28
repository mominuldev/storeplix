import type { StorefrontTrackingConfig } from '@storeplix/types';
import { hasBrowserTracking } from '@/lib/tracking-config';
import { consentState } from '@/lib/tracking-consent';
import { TrackingRuntime } from './tracking-runtime';

/**
 * Store-layout mount (PHASE-8-9D §6.1). The layout renders this only for a live shop whose config has `tracking`
 * (never Coming soon or preview), so a shop that connects nothing gets byte-identical HTML (S349). `consentCookie` is
 * the first-party `sp_consent` value read by the layout, so the consent bar is server-rendered (no flash).
 */
export function Tracking({ tracking, consentCookie }: { tracking: StorefrontTrackingConfig; consentCookie: string | null }) {
  if (!hasBrowserTracking(tracking)) return null;
  return (
    <TrackingRuntime
      ids={{ meta: tracking.meta_pixel_id, ga4: tracking.ga4_measurement_id, tiktok: tracking.tiktok_pixel_id }}
      collect={tracking.collect}
      initialConsent={consentState(tracking.wait_for_consent, consentCookie)}
    />
  );
}
