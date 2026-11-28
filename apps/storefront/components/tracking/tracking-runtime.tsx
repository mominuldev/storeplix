'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { consentCookieString, trackingAllowed, type ConsentDecision, type ConsentState } from '@/lib/tracking-consent';
import { TTCLID_COOKIE, TTCLID_MAX_AGE, TTCLID_RE } from '@/lib/tracking-context';
import { BeaconQueue, cleanPagePath, makeEvent, sendBeacon, tagCalls, type TrackInput } from '@/lib/tracking-events';
import { ConsentBar } from './consent-bar';
import { fireTags, loadPixels, type PixelIds } from './loaders';

interface Props {
  ids: PixelIds;
  /** post events to the beacon (`StorefrontTrackingConfig.collect`) */
  collect: boolean;
  initialConsent: ConsentState;
}

const secure = () => window.location.protocol === 'https:';

/** TikTok click id from the landing URL → first-party cookie, read server-side for the beacon and checkout (§5.5). */
function captureTtclid(): void {
  const v = new URLSearchParams(window.location.search).get('ttclid');
  if (v && TTCLID_RE.test(v)) document.cookie = `${TTCLID_COOKIE}=${v}; Path=/; Max-Age=${TTCLID_MAX_AGE}; SameSite=Lax${secure() ? '; Secure' : ''}`;
}

/**
 * Tracking runtime (PHASE-8-9D §6.1–§6.2), mounted by the store layout only for a live shop with tracking on. While
 * consent is pending it renders the consent bar and does nothing else. Once allowed: loads the tags after hydration,
 * sends `page_view` on every route change, and takes page events from `window.__spTrack` — each fired to the tags and
 * queued to the beacon with one shared event id.
 */
export function TrackingRuntime({ ids, collect, initialConsent }: Props) {
  const [consent, setConsent] = useState<ConsentState>(initialConsent);
  const allowed = trackingAllowed(consent);
  const pathname = usePathname();
  const handler = useRef<((input: TrackInput) => void) | null>(null);
  const lastPath = useRef<string | null>(null);
  const { meta, ga4, tiktok } = ids;

  useEffect(() => {
    if (!allowed) {
      // Events reported before a decision are dropped, never sent later.
      if (Array.isArray(window.__spTrack)) window.__spTrack = [];
      return;
    }
    const live = loadPixels({ meta, ga4, tiktok });
    if (live.tiktok) captureTtclid();
    const queue = collect ? new BeaconQueue({ send: sendBeacon }) : null;
    const handle = (input: TrackInput) => {
      const event = makeEvent(input, cleanPagePath(window.location.pathname));
      fireTags(tagCalls(event, window.location.href), live);
      queue?.push(event.beacon);
    };
    handler.current = handle;
    const pending = Array.isArray(window.__spTrack) ? window.__spTrack.slice(0, 20) : [];
    window.__spTrack = { push: handle };
    // After this commit's page_view (next effect).
    const drain = pending.length ? setTimeout(() => pending.forEach(handle), 0) : null;

    const flush = () => queue?.flushAll();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (drain) clearTimeout(drain);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
      handler.current = null;
      window.__spTrack = [];
    };
  }, [allowed, collect, meta, ga4, tiktok]);

  useEffect(() => {
    if (!allowed || !handler.current || lastPath.current === pathname) return;
    lastPath.current = pathname;
    handler.current({ name: 'page_view' });
  }, [allowed, pathname]);

  const decide = (decision: ConsentDecision) => {
    document.cookie = consentCookieString(decision, secure());
    setConsent(decision);
  };

  return consent === 'pending' ? <ConsentBar onDecide={decide} /> : null;
}
