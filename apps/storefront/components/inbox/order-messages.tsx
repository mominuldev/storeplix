'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { InboxReplyTime } from '@storeplix/types';
import { DEFAULT_LANG, INBOX_COPY, tr, type Lang } from '@/lib/inbox-copy';
import { POLL } from '@/lib/inbox-shared';
import { Icon } from '@/themes/modern-commerce/components/icon';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { useThread, type ThreadUrls } from './use-thread';

interface Props {
  number: string;
  replyTime: InboxReplyTime;
  /** `track` (token from the track action / magic link) or `confirmation` (thank-you page, minted from `sp_order`) */
  via: 'track' | 'confirmation';
  lang?: Lang;
  /** scroll into view on mount (magic link `/track?view=messages`) */
  focus?: boolean;
}

/**
 * Order **Messages** card (PHASE-8-8E §10, Figma 2126:10642): on the `/track` result and `/checkout/thank-you`.
 * Thread (shop bubble bg/sunken, customer bubble bg/brand + "Seen"), attachments, textarea, "Attach photo or PDF",
 * **Send**, and the SMS note. Polls every 10 s (paused when hidden, stopped after 30 min idle). The access token never
 * reaches this component: the route handlers read it from the httpOnly `sp_order_access` cookie.
 */
export function OrderMessages({ number, replyTime, via, lang = DEFAULT_LANG, focus = false }: Props) {
  const qs = `number=${encodeURIComponent(number)}&via=${via}`;
  const urls = useMemo<ThreadUrls>(
    () => ({
      list: (after) => `/api/order-messages?${qs}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      send: `/api/order-messages?${qs}`,
      seen: `/api/order-messages/seen?${qs}`,
    }),
    [qs],
  );
  const t = useThread({ urls, interval: POLL.orderCard, active: true, lang });
  const attachmentUrl = useCallback((id: string) => `/api/order-messages/attachments/${encodeURIComponent(id)}?number=${encodeURIComponent(number)}`, [number]);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus]);

  const expired = t.status === 'ended';

  return (
    <section ref={ref} id="messages" aria-labelledby="order-messages-title" onPointerDown={t.touch} className="flex scroll-mt-24 flex-col gap-4 rounded-sf-md border border-line bg-surface p-5 lg:p-6" data-sp-order-messages>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="order-messages-title" className="type-h3 text-ink">
          {tr(INBOX_COPY.orderTitle, lang)}
        </h2>
        <p className="type-body-s text-ink-muted">{tr(INBOX_COPY.replyTime(replyTime), lang)}</p>
      </div>
      {t.offline ? (
        <p role="alert" className="type-body-s rounded-sf-sm bg-accent-soft px-3 py-2 text-sale">
          {tr(INBOX_COPY.offline, lang)}
        </p>
      ) : null}
      {expired ? (
        <p role="status" className="type-body-s flex items-start gap-2 rounded-sf-sm bg-sunken px-3 py-2.5 text-ink-secondary" data-sp-order-messages-expired>
          <Icon name="info" className="mt-0.5" />
          {tr(INBOX_COPY.orderExpired, lang)}
        </p>
      ) : t.status === 'loading' ? (
        <p className="type-body-s text-ink-muted" role="status">
          {tr(INBOX_COPY.loading, lang)}
        </p>
      ) : t.status === 'error' ? (
        <p role="alert" className="type-body-s text-sale">
          {tr(INBOX_COPY.loadError, lang)}{' '}
          <button type="button" onClick={t.reload} className="underline">
            {tr(INBOX_COPY.retry, lang)}
          </button>
        </p>
      ) : t.messages.length === 0 && t.pending.length === 0 ? (
        <p className="type-body-s text-ink-muted" data-sp-order-messages-empty>
          {tr(INBOX_COPY.orderEmpty, lang)}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <MessageList messages={t.messages} pending={t.pending} tone="sunken" lang={lang} attachmentUrl={attachmentUrl} onRetry={t.retry} showShopMeta labelledBy="order-messages-title" />
        </div>
      )}
      {expired ? null : <Composer variant="card" lang={lang} error={t.sendError} onSend={t.send} onInteract={t.touch} />}
      <p className="type-body-s text-ink-muted">{tr(INBOX_COPY.orderNote, lang)}</p>
    </section>
  );
}
