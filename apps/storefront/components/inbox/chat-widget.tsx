'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxReplyTime, InboxWidgetSession } from '@storeplix/types';
import { DEFAULT_LANG, INBOX_COPY, tr, type Lang } from '@/lib/inbox-copy';
import { hasChatHint, nextPollDelay, POLL } from '@/lib/inbox-shared';
import { Icon } from '@/themes/modern-commerce/components/icon';
import { clientFetch } from './client-api';

/** What the store layout passes (server → client); no tokens, no personal data. */
export interface ChatWidgetConfig {
  shopName: string;
  logoUrl: string | null;
  replyTime: InboxReplyTime;
  hours: string | null;
  greeting: string | null;
}

// The panel (forms, thread, polling) loads only when the shopper opens the chat.
const ChatPanel = dynamic(() => import('./chat-panel'), { ssr: false });

const TEASER_KEY = 'sp_chat_teaser_dismissed';

function readTeaserDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(TEASER_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Website chat launcher (PHASE-8-8E §9.3; Figma 2125:9509 closed, 2125:9736 open, 2126:10484 mobile sheet). Mounted by
 * the store layout only when `config.inbox.web_chat` is set on a live (not draft, not preview) store. Closed, it is a
 * pill "Chat with us" bottom-right 32 px with an unread badge and a dismissible teaser; with a chat session it checks
 * the badge every 60 s (paused when hidden, stopped after 30 min idle).
 */
export function ChatWidget({ config, lang = DEFAULT_LANG }: { config: ChatWidgetConfig; lang?: Lang }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<InboxWidgetSession | null>(null);
  const [teaser, setTeaser] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const lastInteraction = useRef(Date.now());

  const refreshSession = useCallback(async () => {
    const r = await clientFetch<InboxWidgetSession>('/api/chat/session');
    if (r.ok && 'data' in r && r.data) setSession(r.data);
    else if (!r.ok && r.error.code !== 'network_error') setSession(null);
  }, []);

  // First paint: teaser state, magic-link `?chat=open`, existing session.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get('chat') === 'open';
    if (fromLink) {
      params.delete('chat');
      const qs = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    }
    const hinted = hasChatHint(document.cookie);
    const run = async () => {
      if (hinted || fromLink) await refreshSession();
      setLoaded(true);
      if (fromLink) setOpen(true);
      else if (!hinted && !readTeaserDismissed()) setTeaser(true);
    };
    void run();
  }, [refreshSession]);

  // Closed with a session: badge poll every 60 s.
  useEffect(() => {
    if (open || !session || session.status === 'pending') return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = nextPollDelay({ interval: POLL.widgetClosed, hidden: document.visibilityState === 'hidden', lastInteraction: lastInteraction.current, now: Date.now() });
      if (delay !== null) timer = setTimeout(() => void refreshSession().then(schedule), delay);
    };
    schedule();
    const onVisible = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void refreshSession().then(schedule);
    };
    const onInteract = () => {
      const stopped = Date.now() - lastInteraction.current >= POLL.idleStop;
      lastInteraction.current = Date.now();
      if (stopped) {
        clearTimeout(timer);
        void refreshSession().then(schedule);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pointerdown', onInteract, { passive: true });
    window.addEventListener('keydown', onInteract);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pointerdown', onInteract);
      window.removeEventListener('keydown', onInteract);
    };
  }, [open, session, refreshSession]);

  const dismissTeaser = () => {
    setTeaser(false);
    try {
      window.sessionStorage.setItem(TEASER_KEY, '1');
    } catch {
      /* storage blocked: the teaser simply returns on the next page */
    }
  };

  const toggle = () => {
    setTeaser(false);
    setOpen((o) => !o);
  };
  const close = useCallback(() => setOpen(false), []);

  const unread = open ? 0 : (session?.unread_count ?? 0);
  const label = unread > 0 ? tr(INBOX_COPY.launcherUnread(unread), lang) : tr(INBOX_COPY.launcher, lang);

  return (
    <div data-sp-chat-widget>
      {open ? (
        <ChatPanel config={config} lang={lang} session={session} onSession={setSession} onClose={close} returnFocusRef={launcherRef} />
      ) : null}
      {teaser && !open ? (
        <div className="fixed right-4 bottom-[96px] z-40 flex w-[260px] items-start gap-2 rounded-sf-lg border border-line bg-surface p-3 shadow-e3 sm:right-8 sm:bottom-[104px]" data-sp-chat-teaser>
          <p className="type-body-s flex-1 text-ink">{tr(INBOX_COPY.teaser, lang)}</p>
          <button type="button" onClick={dismissTeaser} aria-label={tr(INBOX_COPY.dismissTeaser, lang)} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-ink/5">
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : null}
      <button
        ref={launcherRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? tr(INBOX_COPY.close, lang) : label}
        data-loaded={loaded || undefined}
        className={`fixed right-4 bottom-4 z-40 items-center justify-center rounded-full bg-brand text-on-brand shadow-e3 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:right-8 sm:bottom-8 ${
          open ? 'hidden size-[54px] sm:flex' : 'type-label-m flex h-[52px] gap-2 px-5'
        }`}
        data-sp-chat-launcher
      >
        {open ? (
          <Icon name="x" size={22} />
        ) : (
          <>
            <Icon name="chat-circle-dots" size={20} />
            <span aria-hidden>{tr(INBOX_COPY.launcher, lang)}</span>
            {unread > 0 ? (
              <span aria-hidden className="type-label-s absolute -top-1.5 -right-1 grid min-w-5 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-on-accent" data-sp-chat-badge>
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </>
        )}
      </button>
    </div>
  );
}
