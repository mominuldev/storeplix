import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validPixelId, validSiteVerification, pixelScriptUrl } from '@/lib/tracking-ids';
import { hasBrowserTracking, liveTracking, parseTrackingConfig } from '@/lib/tracking-config';
import { consentCookieString, consentState, contextConsent, trackingAllowed } from '@/lib/tracking-consent';
import { BeaconQueue, ULID_RE, cleanPagePath, emitTrack, makeEvent, tagCalls, ulid } from '@/lib/tracking-events';
import { beaconOriginAllowed, parseBeaconBody } from '@/lib/tracking-beacon';
import { buildTrackingContext, gaClientId, gaSessionId, sanitizeTestToken } from '@/lib/tracking-context';
import { fireTags, loadPixels } from '@/components/tracking/loaders';
import { normalizeHost } from '@/lib/host';
import type { StorefrontTrackingConfig, TrackingBeaconEvent } from '@storeplix/types';

/** PHASE-8-9D §16 SF: ID validation, consent gate, event ids + dedupe, beacon batching, checkout context, S331. */

const META = '123456789012345';
const GA4 = 'G-ABC123XYZ9';
const TIKTOK = 'CABCDEFGHIJ123456789';

const INJECTIONS = [
  `${META}'); alert(1); ('`,
  `${META}"</script><script>alert(1)</script>`,
  `<script>fbq('init','${META}')</script>`,
  `${GA4}&callback=evil`,
  `${GA4}\n`,
  ` ${GA4}`,
  'G-abc123', // lower case
  `${TIKTOK}?x=1`,
  'GTM-ABCD12', // web GTM container ID never loads anything
  `javascript:alert(1)`,
  `１２３４５６７８９０１２`, // full-width digits
  '',
  null,
  12345678901,
  { toString: () => META },
];

describe('pixel ID validation (S331, rule 7)', () => {
  it('accepts only exact pattern matches', () => {
    expect(validPixelId('meta_pixel', META)).toBe(META);
    expect(validPixelId('ga4', GA4)).toBe(GA4);
    expect(validPixelId('tiktok_pixel', TIKTOK)).toBe(TIKTOK);
    for (const bad of INJECTIONS) {
      expect(validPixelId('meta_pixel', bad)).toBeNull();
      expect(validPixelId('ga4', bad)).toBeNull();
      expect(validPixelId('tiktok_pixel', bad)).toBeNull();
    }
    expect(validSiteVerification('abcDEF_123-xyz')).toBe('abcDEF_123-xyz');
    expect(validSiteVerification('"><script>')).toBeNull();
    expect(validSiteVerification('<meta name="google-site-verification" content="abc">')).toBeNull();
  });

  it('builds fixed loader URLs on the T47 hosts; never gtm.js', () => {
    expect(pixelScriptUrl('meta_pixel', META)).toBe('https://connect.facebook.net/en_US/fbevents.js');
    expect(pixelScriptUrl('ga4', GA4)).toBe(`https://www.googletagmanager.com/gtag/js?id=${GA4}`);
    expect(pixelScriptUrl('tiktok_pixel', TIKTOK)).toBe(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${TIKTOK}&lib=ttq`);
    for (const bad of INJECTIONS) for (const p of ['meta_pixel', 'ga4', 'tiktok_pixel'] as const) expect(pixelScriptUrl(p, bad)).toBeNull();
  });

  it('config: keeps only allowed fields, re-validates IDs, null when absent', () => {
    expect(parseTrackingConfig(undefined)).toBeNull();
    expect(parseTrackingConfig('x')).toBeNull();
    const t = parseTrackingConfig({
      meta_pixel_id: `${META}');alert(1)//`, ga4_measurement_id: GA4, tiktok_pixel_id: TIKTOK, wait_for_consent: false, collect: true, currency: 'BDT',
      site_verification: { google: 'tok_ABCDEFGH12' }, access_token: 'EAAB-secret', tagging_url: 'https://sgtm.example', test_event_code: 'TEST123',
    });
    expect(t).toEqual({
      meta_pixel_id: null, ga4_measurement_id: GA4, tiktok_pixel_id: TIKTOK, wait_for_consent: false, collect: true, currency: 'BDT',
      site_verification: { google: 'tok_ABCDEFGH12' },
    });
    expect(parseTrackingConfig({})!.wait_for_consent).toBe(true);
    expect(liveTracking('live', t)).toBe(t);
    expect(liveTracking('preview', t)).toBeNull();
    expect(liveTracking('coming_soon', t)).toBeNull();
    expect(liveTracking('live', null)).toBeNull();
    expect(hasBrowserTracking({ ...t!, ga4_measurement_id: null, tiktok_pixel_id: null, collect: false })).toBe(false);
  });
});

describe('static check: tracking components (S331)', () => {
  const dir = join(__dirname, '..', 'components', 'tracking');
  const files = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
  it('never write script text or markup, never load a web GTM container', () => {
    expect(files.length).toBeGreaterThan(3);
    for (const [name, src] of files) {
      for (const banned of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'textContent', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'gtm.js', '/gtm?']) {
        expect(src.includes(banned), `${name} contains ${banned}`).toBe(false);
      }
    }
  });
  it('only the loaders module sets a script src, and only from pixelScriptUrl', () => {
    for (const [name, src] of files) {
      const assigns = src.match(/\.src\s*=\s*[^;]+;/g) ?? [];
      if (name === 'loaders.ts') expect(assigns).toEqual(['.src = url;']);
      else expect(assigns).toEqual([]);
    }
    const loaders = files.find(([n]) => n === 'loaders.ts')![1];
    expect(loaders.match(/const url = pixelScriptUrl\(/g)?.length).toBe(3);
  });
});

describe('consent gate (P89D-14)', () => {
  it('state from the shop setting and the sp_consent cookie', () => {
    expect(consentState(false, undefined)).toBe('not_required');
    expect(consentState(false, 'granted')).toBe('not_required');
    expect(consentState(false, 'denied')).toBe('denied');
    expect(consentState(true, undefined)).toBe('pending');
    expect(consentState(true, 'yes')).toBe('pending');
    expect(consentState(true, 'granted')).toBe('granted');
    expect(consentState(true, 'denied')).toBe('denied');
  });
  it('nothing runs while pending or after Decline', () => {
    expect(trackingAllowed('pending')).toBe(false);
    expect(trackingAllowed('denied')).toBe(false);
    expect(trackingAllowed('granted')).toBe(true);
    expect(trackingAllowed('not_required')).toBe(true);
    expect(contextConsent('pending')).toBe('denied');
    expect(contextConsent('granted')).toBe('granted');
    expect(contextConsent('not_required')).toBe('not_required');
  });
  it('first-party cookie, 12 months, readable by the loader', () => {
    const c = consentCookieString('granted', true);
    expect(c).toBe('sp_consent=granted; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    expect(c).not.toMatch(/HttpOnly|Domain/i);
    expect(consentCookieString('denied', false)).not.toContain('Secure');
  });
});

describe('event ids and dedupe helpers (P89D-12)', () => {
  it('ulid: 26 Crockford chars, time-ordered', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(ULID_RE);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => ulid())).size).toBe(200);
  });

  it('the tag calls and the beacon copy share one event id', () => {
    const e = makeEvent({ name: 'add_to_cart', variant_id: '01JVARIANT0000000000000001', quantity: 2, value_amount: 250000, currency: 'BDT' }, '/products/x', 1_700_000_000_000, '01JEVENT000000000000000001');
    const calls = tagCalls(e, 'https://demo.localhost/products/x');
    expect(e.beacon).toEqual({ event_id: '01JEVENT000000000000000001', name: 'add_to_cart', occurred_at: '2023-11-14T22:13:20.000Z', page_path: '/products/x', variant_id: '01JVARIANT0000000000000001', quantity: 2 });
    expect(e.beacon).not.toHaveProperty('value_amount');
    expect(calls.meta).toEqual({ name: 'AddToCart', params: { content_type: 'product', content_ids: ['01JVARIANT0000000000000001'], value: 2500, currency: 'BDT' }, options: { eventID: e.event_id } });
    expect(calls.ga4).toMatchObject({ name: 'add_to_cart', params: { event_id: e.event_id, value: 2500, currency: 'BDT', items: [{ item_id: '01JVARIANT0000000000000001', quantity: 2 }] } });
    expect(calls.tiktok).toMatchObject({ name: 'AddToCart', options: { event_id: e.event_id } });
    const pv = tagCalls(makeEvent({ name: 'page_view' }, '/'), 'https://demo.localhost/');
    expect(pv.meta!.name).toBe('PageView');
    expect(pv.tiktok!.name).toBe('Pageview');
    expect(pv.ga4).toMatchObject({ name: 'page_view', params: { page_location: 'https://demo.localhost/' } });
    expect(tagCalls(makeEvent({ name: 'begin_checkout', value_amount: 127000, currency: 'BDT', num_items: 3 }, '/checkout'), '').meta).toMatchObject({ name: 'InitiateCheckout', params: { value: 1270, num_items: 3 } });
  });

  it('page paths never carry a query or hash', () => {
    expect(cleanPagePath('/checkout/thank-you?token=abc#x')).toBe('/checkout/thank-you');
    expect(cleanPagePath('//evil.example/x')).toBe('/');
    expect(cleanPagePath('relative')).toBe('/');
  });

  it('emitTrack is a no-op without the runtime; buffers only when asked', () => {
    const w: { __spTrack?: unknown } = {};
    vi.stubGlobal('window', w);
    emitTrack({ name: 'add_to_cart' });
    expect(w.__spTrack).toBeUndefined();
    emitTrack({ name: 'view_item', product_id: '01JPRODUCT0000000000000001' }, { buffer: true });
    expect(w.__spTrack).toEqual([{ name: 'view_item', product_id: '01JPRODUCT0000000000000001' }]);
    const seen: unknown[] = [];
    w.__spTrack = { push: (i: unknown) => seen.push(i) };
    emitTrack({ name: 'add_to_cart' });
    expect(seen).toEqual([{ name: 'add_to_cart' }]);
    vi.unstubAllGlobals();
  });
});

describe('beacon queue (§6.2: ≤ 20 per batch, ≤ 1 send per 2 s)', () => {
  const ev = (i: number): TrackingBeaconEvent => ({ event_id: `01JEVENT${String(i).padStart(18, '0')}`, name: 'page_view', occurred_at: '2026-11-28T10:00:00.000Z', page_path: '/' });

  it('batches and rate-limits', () => {
    let now = 10_000;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const sent: TrackingBeaconEvent[][] = [];
    const q = new BeaconQueue({ send: (b) => sent.push(b), now: () => now, setTimer: (fn, ms) => timers.push({ fn, at: now + ms }) });
    for (let i = 0; i < 45; i++) q.push(ev(i));
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(10_000);
    timers.shift()!.fn();
    expect(sent.map((b) => b.length)).toEqual([20]);
    expect(timers[0]!.at).toBe(12_000); // next batch waits 2 s
    now = 12_000;
    timers.shift()!.fn();
    now = 14_000;
    timers.shift()!.fn();
    expect(sent.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(timers).toHaveLength(0);
  });

  it('flushAll on page hide; a throwing sender never escapes', () => {
    const q = new BeaconQueue({ send: () => { throw new Error('x'); }, setTimer: () => 0 });
    for (let i = 0; i < 25; i++) q.push(ev(i));
    expect(() => q.flushAll()).not.toThrow();
    expect(q.size).toBe(0);
  });
});

describe('beacon body + origin (S335)', () => {
  const good = { event_id: '01JEVENT000000000000000001', name: 'view_item', occurred_at: '2026-11-28T10:00:00Z', page_path: '/products/x?utm=1', product_id: '01JPRODUCT0000000000000001', quantity: 1, value: 999999 };
  it('drops bad events, dedupes, caps at 20, strips prices and queries', () => {
    const events = parseBeaconBody(JSON.stringify({ events: [good, good, { ...good, event_id: 'nope' }, { ...good, event_id: '01JEVENT000000000000000002', name: 'purchase' }, { ...good, event_id: '01JEVENT000000000000000003', page_path: '/x\u0000' }] }));
    expect(events).toEqual([{ event_id: good.event_id, name: 'view_item', occurred_at: '2026-11-28T10:00:00.000Z', page_path: '/products/x', product_id: good.product_id, quantity: 1 }]);
    const many = Array.from({ length: 30 }, (_, i) => ({ ...good, event_id: `01JEVENT${String(i).padStart(18, '0')}` }));
    expect(parseBeaconBody(JSON.stringify({ events: many }))).toHaveLength(20);
    expect(parseBeaconBody('not json')).toEqual([]);
    expect(parseBeaconBody('{"events":"x"}')).toEqual([]);
  });
  it('same-origin only', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(beaconOriginAllowed(h({ origin: 'http://demo.localhost' }), 'demo.localhost', normalizeHost)).toBe(true);
    expect(beaconOriginAllowed(h({ 'sec-fetch-site': 'same-origin' }), 'demo.localhost', normalizeHost)).toBe(true);
    expect(beaconOriginAllowed(h({ origin: 'https://evil.example' }), 'demo.localhost', normalizeHost)).toBe(false);
    expect(beaconOriginAllowed(h({ origin: 'http://demo.localhost', 'sec-fetch-site': 'cross-site' }), 'demo.localhost', normalizeHost)).toBe(false);
    expect(beaconOriginAllowed(h({ origin: 'null' }), 'demo.localhost', normalizeHost)).toBe(false);
    expect(beaconOriginAllowed(h({}), 'demo.localhost', normalizeHost)).toBe(false);
  });
});

describe('checkout / beacon context from cookies (§5.5)', () => {
  const tracking: StorefrontTrackingConfig = { meta_pixel_id: META, ga4_measurement_id: GA4, tiktok_pixel_id: TIKTOK, wait_for_consent: false, collect: true, currency: 'BDT', site_verification: { google: null } };
  const jar: Record<string, string> = {
    _fbp: 'fb.1.1700000000000.1234567890', _fbc: 'fb.1.1700000000000.IwAR2abc_DEF-123', _ttp: 'abcDEF123456789', sp_ttclid: 'E.C.P.abcdefgh12345',
    _ga: 'GA1.1.123456789.1700000000', [`_ga_${GA4.slice(2)}`]: 'GS2.1.s1700000123$o1$g0$t1700000123', sp_track_test: 'test.token-abcdefgh12345',
  };
  const read = (j: Record<string, string>) => (n: string) => j[n];

  it('reads first-party ids, consent and UA', () => {
    expect(buildTrackingContext(tracking, read(jar), 'Mozilla/5.0\u0000 Test')).toEqual({
      consent: 'not_required', user_agent: 'Mozilla/5.0 Test', test_token: 'test.token-abcdefgh12345',
      fbp: jar._fbp, fbc: jar._fbc, ttp: jar._ttp, ttclid: jar.sp_ttclid, ga_client_id: '123456789.1700000000', ga_session_id: '1700000123',
    });
  });
  it('drops malformed values; sends no ids when consent is denied or pending', () => {
    const bad = buildTrackingContext(tracking, read({ _fbp: 'fb.1.x"<script>', _ga: 'nope', sp_ttclid: 'a b' }), null);
    expect(bad).toMatchObject({ fbp: null, ga_client_id: null, ttclid: null, user_agent: null });
    const waiting = { ...tracking, wait_for_consent: true };
    expect(buildTrackingContext(waiting, read(jar), 'UA')).toEqual({ consent: 'denied', user_agent: 'UA', test_token: 'test.token-abcdefgh12345' });
    expect(buildTrackingContext(waiting, read({ ...jar, sp_consent: 'granted' }), 'UA')).toMatchObject({ consent: 'granted', fbp: jar._fbp });
    expect(buildTrackingContext({ ...tracking, meta_pixel_id: null }, read(jar), 'UA')).not.toHaveProperty('fbp');
  });
  it('GA cookie formats', () => {
    expect(gaClientId('GA1.2.987.654')).toBe('987.654');
    expect(gaSessionId('GS1.1.1700000123.4.1.1700000999.0.0.0')).toBe('1700000123');
    expect(gaSessionId('GS2.1.s1700000123$o5')).toBe('1700000123');
    expect(gaSessionId('garbage')).toBeNull();
    expect(sanitizeTestToken('short')).toBeNull();
    expect(sanitizeTestToken('a'.repeat(20))).toBe('a'.repeat(20));
  });
});

describe('loaders (official base tags from fixed code)', () => {
  interface El { async?: boolean; src?: string; dataset: Record<string, string> }
  const appended: El[] = [];
  const setup = () => {
    appended.length = 0;
    const w: Record<string, unknown> = {};
    vi.stubGlobal('window', w);
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {} }),
      querySelector: (sel: string) => appended.find((e) => sel.includes(`"${e.dataset.spTag}"`)) ?? null,
      head: { appendChild: (e: El) => appended.push(e) },
    });
    return w;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('loads each valid tag once with its ID as data; fires with the shared event id', () => {
    const w = setup();
    const live = loadPixels({ meta: META, ga4: GA4, tiktok: TIKTOK });
    loadPixels({ meta: META, ga4: GA4, tiktok: TIKTOK });
    expect(live).toEqual({ meta: META, ga4: GA4, tiktok: TIKTOK });
    expect(appended.map((e) => e.src)).toEqual([
      'https://connect.facebook.net/en_US/fbevents.js',
      `https://www.googletagmanager.com/gtag/js?id=${GA4}`,
      `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${TIKTOK}&lib=ttq`,
    ]);
    expect(appended.every((e) => e.async)).toBe(true);
    const fbq = w.fbq as { queue: ArrayLike<unknown>[] };
    expect(fbq.queue.map((a) => Array.from(a))).toEqual([['init', META]]);
    const dl = (w.dataLayer as ArrayLike<unknown>[]).map((a) => Array.from(a));
    expect(dl[1]).toEqual(['config', GA4, { send_page_view: false }]);

    const e = makeEvent({ name: 'view_item', product_id: '01JPRODUCT0000000000000001' }, '/products/x');
    fireTags(tagCalls(e, 'https://demo.localhost/products/x'), live);
    expect(Array.from(fbq.queue[1]!)).toEqual(['track', 'ViewContent', { content_type: 'product', content_ids: ['01JPRODUCT0000000000000001'] }, { eventID: e.event_id }]);
    expect(Array.from((w.dataLayer as ArrayLike<unknown>[]).at(-1)!)).toEqual(['event', 'view_item', expect.objectContaining({ event_id: e.event_id, send_to: GA4 })]);
    expect((w.ttq as unknown[]).at(-1)).toEqual(['track', 'ViewContent', expect.any(Object), { event_id: e.event_id }]);
  });

  it('an injected ID loads nothing', () => {
    const w = setup();
    const live = loadPixels({ meta: `${META}');alert(1);//`, ga4: 'GTM-ABCD12', tiktok: null });
    expect(live).toEqual({ meta: null, ga4: null, tiktok: null });
    expect(appended).toEqual([]);
    expect(w.fbq).toBeUndefined();
    expect(w.gtag).toBeUndefined();
  });
});

describe('Nagad (PHASE-8-9D §9.6)', async () => {
  const { METHOD_LABEL, checkoutMethods, isOfferedMethod, isPaymentMethod } = await import('@/lib/payments');
  const { CHECKOUT_METHOD_BADGES } = await import('@/themes/modern-commerce/footer');
  it('is labelled, badged and offered only when the store config lists it', () => {
    expect(METHOD_LABEL.nagad).toBe('Nagad');
    expect(CHECKOUT_METHOD_BADGES.nagad).toEqual(['nagad']);
    expect(isOfferedMethod('nagad')).toBe(true);
    expect(isPaymentMethod('nagad')).toBe(true);
    expect(checkoutMethods(['cod', 'nagad', 'bkash'])).toEqual(['cod', 'bkash', 'nagad']);
    expect(checkoutMethods(['cod', 'bkash'])).toEqual(['cod', 'bkash']);
  });
});
