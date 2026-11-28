import type { StorefrontTrackingConfig, TrackingBrowserContext } from '@storeplix/types';
import { CONSENT_COOKIE, consentState, contextConsent } from './tracking-consent';

/**
 * `TrackingBrowserContext` (PHASE-8-9D §5.5) built server-side from the store host's own first-party cookies and the
 * request's user agent. Pure (cookie reader injected). Used by the beacon route and by checkout (`CheckoutInput.tracking`).
 * Malformed values are dropped, never an error: checkout must not fail on tracking. With consent `denied` only the
 * consent itself (and the UA) is sent — no click or browser ids.
 */

export const TTCLID_COOKIE = 'sp_ttclid';
export const TTCLID_MAX_AGE = 30 * 24 * 3600;
export const TEST_MODE_COOKIE = 'sp_track_test';
export const TEST_MODE_PARAM = 'sp_test';
export const TEST_MODE_MAX_AGE = 30 * 60;

export type CookieReader = (name: string) => string | undefined;

const FBP_RE = /^fb\.\d\.\d{10,16}\.\d{1,25}$/;
const FBC_RE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,450}$/;
const TTP_RE = /^[A-Za-z0-9._-]{8,200}$/;
export const TTCLID_RE = /^[A-Za-z0-9._-]{8,500}$/;
const GA_RE = /^GA\d\.\d\.(\d{1,20}\.\d{1,20})$/;
/** `GS1.1.<session>.…` (classic) or `GS2.1.s<session>$o…` (2025 format). */
const GA_SESSION_RE = /^GS1\.\d\.(\d{6,20})\.|^GS2\.\d\.s(\d{6,20})(?:\$|$)/;
export const TEST_TOKEN_RE = /^[A-Za-z0-9._~-]{16,1024}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function sanitizeTestToken(v: string | null | undefined): string | null {
  return v && TEST_TOKEN_RE.test(v) ? v : null;
}

const match = (re: RegExp, v: string | undefined) => (v !== undefined && re.test(v) ? v : null);

export function gaClientId(cookie: string | undefined): string | null {
  return cookie ? (GA_RE.exec(cookie)?.[1] ?? null) : null;
}

export function gaSessionId(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const m = GA_SESSION_RE.exec(cookie);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function cleanUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const v = ua.replace(CONTROL, '').trim().slice(0, 400);
  return v || null;
}

export function buildTrackingContext(tracking: StorefrontTrackingConfig, cookie: CookieReader, userAgent: string | null | undefined): TrackingBrowserContext {
  const consent = contextConsent(consentState(tracking.wait_for_consent, cookie(CONSENT_COOKIE)));
  const ctx: TrackingBrowserContext = { consent, user_agent: cleanUserAgent(userAgent) };
  const test = match(TEST_TOKEN_RE, cookie(TEST_MODE_COOKIE));
  if (test) ctx.test_token = test;
  if (consent === 'denied') return ctx;

  if (tracking.meta_pixel_id) {
    ctx.fbp = match(FBP_RE, cookie('_fbp'));
    ctx.fbc = match(FBC_RE, cookie('_fbc'));
  }
  if (tracking.tiktok_pixel_id) {
    ctx.ttp = match(TTP_RE, cookie('_ttp'));
    ctx.ttclid = match(TTCLID_RE, cookie(TTCLID_COOKIE));
  }
  if (tracking.ga4_measurement_id) {
    ctx.ga_client_id = gaClientId(cookie('_ga'));
    ctx.ga_session_id = gaSessionId(cookie(`_ga_${tracking.ga4_measurement_id.slice(2)}`));
  }
  return ctx;
}
