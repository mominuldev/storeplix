import type { TrackingConsent } from '@storeplix/types';

/**
 * Storeplix consent bar state (PHASE-8-9D P89D-14). Pure and client-safe. The decision lives in the first-party
 * `sp_consent` cookie (12 months, not httpOnly so the loader can read it, SameSite=Lax). No third-party CMP.
 */
export const CONSENT_COOKIE = 'sp_consent';
export const CONSENT_MAX_AGE = 365 * 24 * 3600;

export type ConsentDecision = 'granted' | 'denied';
/** `pending` = the shop waits for consent and the shopper hasn't answered: show the bar, load and send nothing. */
export type ConsentState = ConsentDecision | 'pending' | 'not_required';

export function parseConsentCookie(value: string | null | undefined): ConsentDecision | null {
  return value === 'granted' || value === 'denied' ? value : null;
}

export function consentState(waitForConsent: boolean, cookie: string | null | undefined): ConsentState {
  const decision = parseConsentCookie(cookie);
  if (!waitForConsent) return decision === 'denied' ? 'denied' : 'not_required';
  return decision ?? 'pending';
}

/** Tags and browser events run only when this is true: never before Accept on a shop that waits. */
export function trackingAllowed(state: ConsentState): boolean {
  return state === 'granted' || state === 'not_required';
}

/** Consent as sent to the API with the beacon and checkout (`TrackingBrowserContext.consent`). */
export function contextConsent(state: ConsentState): TrackingConsent {
  return state === 'granted' ? 'granted' : state === 'not_required' ? 'not_required' : 'denied';
}

/** `document.cookie` string for a decision (host-only). */
export function consentCookieString(decision: ConsentDecision, secure: boolean): string {
  return `${CONSENT_COOKIE}=${decision}; Path=/; Max-Age=${CONSENT_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
