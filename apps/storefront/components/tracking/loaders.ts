import { pixelScriptUrl, validPixelId, type BrowserPixel } from '@/lib/tracking-ids';
import type { TagCalls } from '@/lib/tracking-events';

/**
 * Official base tags (PHASE-8-9D §6.1, P89D-8): Storeplix-authored equivalents of the Meta Pixel, GA4 gtag and TikTok
 * Pixel snippets. Fixed code only — the merchant's ID is a validated function argument and, in the vendor script URL,
 * URL-encoded. No inline `<script>` is written (CSP-friendly: only the T47 hosts need allowing), and no web GTM
 * container script is ever loaded (P89D-9). Client-only; called after hydration.
 */

type Fn = (...args: unknown[]) => void;
interface Fbq extends Fn {
  callMethod?: Fn;
  queue: unknown[];
  push: Fbq;
  loaded: boolean;
  version: string;
}
interface Ttq extends Array<unknown> {
  methods: string[];
  setAndDefer: (target: Record<string, unknown>, method: string) => void;
  instance: (id: string) => unknown;
  load: (id: string) => void;
  _i?: Record<string, unknown[] & { _u?: string }>;
  _t?: Record<string, number>;
  _o?: Record<string, Record<string, unknown>>;
  track: Fn;
}
interface TagWindow {
  fbq?: Fbq;
  _fbq?: Fbq;
  dataLayer?: unknown[];
  gtag?: Fn;
  ttq?: Ttq;
  TiktokAnalyticsObject?: string;
}

export interface PixelIds {
  meta: string | null;
  ga4: string | null;
  tiktok: string | null;
}

const tagWindow = () => window as unknown as TagWindow;

function inject(provider: BrowserPixel, url: string): void {
  if (document.querySelector(`script[data-sp-tag="${provider}"]`)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = url;
  s.dataset.spTag = provider;
  document.head.appendChild(s);
}

const inited = new Set<string>();

function loadMeta(id: string): void {
  const url = pixelScriptUrl('meta_pixel', id);
  if (!url) return;
  const w = tagWindow();
  if (!w.fbq) {
    const n = function (this: unknown) {
      // The official stub queues `arguments` objects; fbevents.js replays them.
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      if (n.callMethod) n.callMethod(...Array.from(args));
      else n.queue.push(args);
    } as unknown as Fbq;
    w.fbq = n;
    if (!w._fbq) w._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
  }
  inject('meta_pixel', url);
  if (!inited.has(`meta:${id}`)) {
    inited.add(`meta:${id}`);
    w.fbq('init', id);
  }
}

function loadGa4(id: string): void {
  const url = pixelScriptUrl('ga4', id);
  if (!url) return;
  const w = tagWindow();
  w.dataLayer = w.dataLayer ?? [];
  if (!w.gtag) {
    // gtag.js only reads `arguments` objects from the dataLayer (not arrays).
    w.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      tagWindow().dataLayer!.push(arguments);
    };
    w.gtag('js', new Date());
  }
  inject('ga4', url);
  if (!inited.has(`ga4:${id}`)) {
    inited.add(`ga4:${id}`);
    // Page views are sent by us (with an event id) on every client navigation.
    w.gtag('config', id, { send_page_view: false });
  }
}

const TTQ_METHODS = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];

function loadTiktok(id: string): void {
  const url = pixelScriptUrl('tiktok_pixel', id);
  if (!url) return;
  const w = tagWindow();
  if (!w.ttq) {
    w.TiktokAnalyticsObject = 'ttq';
    const ttq = [] as unknown as Ttq;
    ttq.methods = TTQ_METHODS;
    ttq.setAndDefer = (target, method) => {
      target[method] = (...args: unknown[]) => {
        (target as unknown as unknown[]).push([method, ...args]);
      };
    };
    for (const m of TTQ_METHODS) ttq.setAndDefer(ttq as unknown as Record<string, unknown>, m);
    ttq.instance = (pixel: string) => {
      const inst = (ttq._i?.[pixel] ?? []) as unknown as Record<string, unknown>;
      for (const m of TTQ_METHODS) ttq.setAndDefer(inst, m);
      return inst;
    };
    // Same bookkeeping as the official `ttq.load`, but the script is injected by `inject` from the fixed URL.
    ttq.load = (pixel: string) => {
      const base = url.split('?')[0]!;
      ttq._i = ttq._i ?? {};
      ttq._i[pixel] = Object.assign([], { _u: base });
      ttq._t = ttq._t ?? {};
      ttq._t[pixel] = Date.now();
      ttq._o = ttq._o ?? {};
      ttq._o[pixel] = {};
    };
    w.ttq = ttq;
  }
  if (!inited.has(`tiktok:${id}`)) {
    inited.add(`tiktok:${id}`);
    w.ttq.load(id);
  }
  inject('tiktok_pixel', url);
}

/** Loads each tag whose ID is valid; returns which ones are live (an invalid ID loads nothing). */
export function loadPixels(ids: PixelIds): PixelIds {
  const meta = validPixelId('meta_pixel', ids.meta);
  const ga4 = validPixelId('ga4', ids.ga4);
  const tiktok = validPixelId('tiktok_pixel', ids.tiktok);
  if (meta) loadMeta(meta);
  if (ga4) loadGa4(ga4);
  if (tiktok) loadTiktok(tiktok);
  return { meta, ga4, tiktok };
}

/** One browser event to every live tag, all carrying the same event id (P89D-12). Errors never escape. */
export function fireTags(calls: TagCalls, live: PixelIds): void {
  const w = tagWindow();
  try {
    if (live.meta && calls.meta && w.fbq) w.fbq('track', calls.meta.name, calls.meta.params, calls.meta.options);
    if (live.ga4 && calls.ga4 && w.gtag) w.gtag('event', calls.ga4.name, { ...calls.ga4.params, send_to: live.ga4 });
    // VERIFY (P89D §5.1): TikTok page views use the `Pageview` name with an event id so the Events API mirror dedupes.
    if (live.tiktok && calls.tiktok && w.ttq) w.ttq.track(calls.tiktok.name, calls.tiktok.params, calls.tiktok.options);
  } catch {
    // A vendor script error never breaks the shop.
  }
}
