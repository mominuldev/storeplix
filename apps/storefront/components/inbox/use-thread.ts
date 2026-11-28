'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxErrorText, type Lang, type ShopperError } from '@/lib/inbox-copy';
import { mergeMessages, newestShopId, nextPollDelay, pollCursor, type PendingMessage, type ThreadMessage } from '@/lib/inbox-shared';
import { clientFetch, jsonPost, newClientId } from './client-api';

/**
 * Shopper thread state shared by the chat widget and the order Messages card (PHASE-8-8E §9.3, §10, §12): first load,
 * `after=` polling with ETag/304, paused while the tab is hidden and stopped after 30 minutes without interaction,
 * `/seen` when new shop rows are on screen, optimistic sends retried with the same `client_id`, offline handling.
 */
export interface ThreadUrls {
  /** GET with `after` appended (`?after=` or `&after=`) */
  list: (after: string | null) => string;
  send: string;
  seen: string;
}

export type ThreadStatus = 'loading' | 'ready' | 'error' | 'ended';

export interface ThreadState {
  messages: ThreadMessage[];
  pending: PendingMessage[];
  status: ThreadStatus;
  /** the code that ended the thread (`inbox_session_invalid`, `order_access_invalid`, `inbox_unavailable`) */
  endedCode: string | null;
  offline: boolean;
  /** text of the last send error (rate limit, offline…) for the composer */
  sendError: string | null;
  /** bumps when a new shop row arrives after the first load (for an announcement) */
  newShopCount: number;
}

const ENDING = new Set(['inbox_session_invalid', 'order_access_invalid', 'inbox_unavailable', 'store_not_live']);

export function useThread(opts: { urls: ThreadUrls; interval: number; active: boolean; lang: Lang; onEnded?: (code: string) => void }) {
  const { urls, interval, active, lang, onEnded } = opts;
  const [state, setState] = useState<ThreadState>({ messages: [], pending: [], status: 'loading', endedCode: null, offline: false, sendError: null, newShopCount: 0 });
  const ref = useRef({ etag: null as string | null, lastInteraction: Date.now(), timer: 0 as unknown as ReturnType<typeof setTimeout>, inFlight: false, acked: null as string | null, loaded: false });
  const messagesRef = useRef<ThreadMessage[]>([]);
  /** the live loop's scheduler (a no-op while inactive), so `touch` can restart a loop stopped by the idle limit */
  const scheduleRef = useRef<() => void>(() => {});
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  const end = useCallback((code: string) => {
    setState((s) => ({ ...s, status: 'ended', endedCode: code }));
    onEndedRef.current?.(code);
  }, []);

  const poll = useCallback(async () => {
    const r0 = ref.current;
    if (r0.inFlight) return;
    r0.inFlight = true;
    const after = r0.loaded ? pollCursor(messagesRef.current) : null;
    const r = await clientFetch<ThreadMessage[]>(urls.list(after), { etag: r0.loaded ? r0.etag : null });
    r0.inFlight = false;
    if (!r.ok) {
      if (ENDING.has(r.error.code)) return end(r.error.code);
      setState((s) => ({ ...s, offline: r.error.code === 'network_error', status: r0.loaded ? s.status : 'error' }));
      return;
    }
    if ('notModified' in r) {
      setState((s) => (s.offline ? { ...s, offline: false } : s));
      return;
    }
    r0.etag = r.etag;
    const incoming = Array.isArray(r.data) ? r.data : [];
    const wasLoaded = r0.loaded;
    r0.loaded = true;
    const before = newestShopId(messagesRef.current);
    const merged = mergeMessages(messagesRef.current, incoming);
    messagesRef.current = merged;
    const after2 = newestShopId(merged);
    setState((s) => ({
      ...s,
      messages: merged,
      status: 'ready',
      offline: false,
      newShopCount: wasLoaded && after2 !== before ? s.newShopCount + 1 : s.newShopCount,
    }));
  }, [urls, end]);

  // Polling loop: only while `active`; paused when hidden, stopped after 30 min idle.
  useEffect(() => {
    if (!active) return;
    const r0 = ref.current;
    let cancelled = false;
    const schedule = () => {
      // Check `cancelled` before touching the shared timer: under strict mode the first mount's in-flight poll resolves
      // after cleanup and would otherwise clear the second mount's timer, stopping the loop (QA 8.8e SF-1).
      if (cancelled) return;
      clearTimeout(r0.timer);
      const delay = nextPollDelay({ interval, hidden: document.visibilityState === 'hidden', lastInteraction: r0.lastInteraction, now: Date.now() });
      if (delay === null) return;
      r0.timer = setTimeout(async () => {
        await poll();
        schedule();
      }, delay);
    };
    scheduleRef.current = schedule;
    void poll().then(schedule);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void poll().then(schedule);
      } else clearTimeout(r0.timer);
    };
    const onOnline = () => {
      setState((s) => ({ ...s, offline: false }));
      void poll().then(schedule);
    };
    const onOffline = () => setState((s) => ({ ...s, offline: true }));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) onOffline();
    return () => {
      cancelled = true;
      scheduleRef.current = () => {};
      clearTimeout(r0.timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [active, interval, poll]);

  // Seen: newest shop row on screen and not yet acknowledged.
  const newestShop = newestShopId(state.messages);
  useEffect(() => {
    if (!active || !newestShop || ref.current.acked === newestShop || document.visibilityState !== 'visible') return;
    const unseen = state.messages.some((m) => m.from === 'shop' && m.id === newestShop);
    if (!unseen) return;
    ref.current.acked = newestShop;
    void clientFetch(urls.seen, jsonPost());
  }, [active, newestShop, state.messages, urls.seen]);

  /** Interaction resets the idle timer and restarts a stopped loop. */
  const touch = useCallback(() => {
    const r0 = ref.current;
    const stopped = Date.now() - r0.lastInteraction >= 30 * 60 * 1000;
    r0.lastInteraction = Date.now();
    if (stopped && active) void poll().then(() => scheduleRef.current());
  }, [active, poll]);

  const deliver = useCallback(
    async (p: PendingMessage, file: File | null) => {
      const form = new FormData();
      form.append('body', p.body);
      form.append('client_id', p.client_id);
      if (file) form.append('file', file, file.name);
      const r = await clientFetch<ThreadMessage>(urls.send, { method: 'POST', body: form });
      if (r.ok && 'data' in r && r.data && typeof r.data === 'object') {
        const merged = mergeMessages(messagesRef.current, [r.data]);
        messagesRef.current = merged;
        setState((s) => ({ ...s, messages: merged, pending: s.pending.filter((x) => x.client_id !== p.client_id), sendError: null }));
        return true;
      }
      const error: ShopperError = r.ok ? { status: 502, code: 'error' } : r.error;
      if (ENDING.has(error.code)) end(error.code);
      const text = inboxErrorText(error, lang);
      setState((s) => ({
        ...s,
        sendError: text,
        offline: error.code === 'network_error' ? true : s.offline,
        pending: s.pending.map((x) => (x.client_id === p.client_id ? { ...x, state: 'failed', error: text } : x)),
      }));
      return false;
    },
    [urls.send, lang, end],
  );

  const files = useRef(new Map<string, File | null>());

  const send = useCallback(
    (body: string, file: File | null) => {
      touch();
      const p: PendingMessage = { client_id: newClientId(), body, file: file ? { name: file.name, size: file.size } : null, state: 'sending', created_at: new Date().toISOString() };
      files.current.set(p.client_id, file);
      setState((s) => ({ ...s, pending: [...s.pending, p], sendError: null }));
      return deliver(p, file);
    },
    [deliver, touch],
  );

  /** Retry a failed send with the same client_id (idempotent on the API). */
  const retry = useCallback(
    (clientId: string) => {
      touch();
      let target: PendingMessage | undefined;
      setState((s) => ({ ...s, pending: s.pending.map((x) => (x.client_id === clientId ? (target = { ...x, state: 'sending', error: undefined }) : x)) }));
      queueMicrotask(() => {
        if (target) void deliver(target, files.current.get(clientId) ?? null);
      });
    },
    [deliver, touch],
  );

  const reload = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }));
    void poll();
  }, [poll]);

  return { ...state, send, retry, reload, touch };
}
