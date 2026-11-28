import { Fragment, type ReactNode } from 'react';
import { INBOX_COPY, tr, type Lang } from '@/lib/inbox-copy';
import { autolink, formatFileSize, lastSeenCustomerIndex, type PendingMessage, type ThreadAttachment, type ThreadMessage } from '@/lib/inbox-shared';
import { formatDhakaClock } from '@/lib/tracking';
import { Icon } from '@/themes/modern-commerce/components/icon';

/**
 * Shopper thread rows (Figma 2125:10004 bubbles; order card 2126:10642). Bodies are plain React text: shop replies
 * are autolinked (http/https, rel nofollow noopener noreferrer, P88E-23); shopper text never is. No raw HTML.
 */

export type ShopTone = 'surface' | 'sunken';

export function ReplyText({ text }: { text: string }) {
  return (
    <>
      {autolink(text).map((p, i) =>
        p.kind === 'link' ? (
          <a key={i} href={p.href} target="_blank" rel="nofollow noopener noreferrer" className="break-all underline">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

function AttachmentView({ a, url, mine, lang }: { a: ThreadAttachment; url: string; mine: boolean; lang: Lang }) {
  if (a.kind === 'image' && a.status === 'ready') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-sf-sm" data-sp-chat-attachment="image">
        <img src={url} alt={a.filename} loading="lazy" className="max-h-44 w-auto max-w-[220px] object-cover" />
      </a>
    );
  }
  const label = a.status === 'processing' ? tr(INBOX_COPY.processing, lang) : `${a.kind === 'pdf' ? tr(INBOX_COPY.pdf, lang) : tr(INBOX_COPY.photo, lang)} · ${formatFileSize(a.size_bytes)}`;
  const body = (
    <>
      <Icon name="paperclip" size={18} className={mine ? 'text-on-brand' : 'text-brand'} />
      <span className="flex min-w-0 flex-col">
        <span className="type-label-s truncate">{a.filename}</span>
        <span className={`type-body-s ${mine ? 'opacity-80' : 'text-ink-muted'}`}>{label}</span>
      </span>
    </>
  );
  const cls = `flex max-w-[240px] items-center gap-2 rounded-sf-md border px-3 py-2 ${mine ? 'border-on-brand/30' : 'border-line bg-surface text-ink'}`;
  return a.status === 'ready' ? (
    <a href={url} target="_blank" rel="noopener noreferrer" download={a.kind === 'pdf' ? a.filename : undefined} className={cls} data-sp-chat-attachment={a.kind}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

function Bubble({ from, tone, children }: { from: 'customer' | 'shop'; tone: ShopTone; children: ReactNode }) {
  const cls =
    from === 'customer'
      ? 'bg-brand text-on-brand'
      : tone === 'sunken'
        ? 'bg-sunken text-ink'
        : 'border border-line bg-surface text-ink';
  return <div className={`type-body-s flex max-w-[85%] flex-col gap-2 rounded-[12px] px-3.5 py-2.5 whitespace-pre-wrap break-words ${cls}`}>{children}</div>;
}

interface ListProps {
  messages: readonly ThreadMessage[];
  pending: readonly PendingMessage[];
  tone: ShopTone;
  lang: Lang;
  attachmentUrl: (id: string) => string;
  onRetry: (clientId: string) => void;
  /** chat: shop greeting bubble at the top */
  lead?: ReactNode;
  /** shown under the last shop row ("Babur Gallery · Nov 2, 3:05 pm" on the order card) */
  showShopMeta?: boolean;
  labelledBy?: string;
}

export function MessageList({ messages, pending, tone, lang, attachmentUrl, onRetry, lead, showShopMeta = false, labelledBy }: ListProps) {
  const seenIdx = lastSeenCustomerIndex(messages);
  return (
    <ol role="log" aria-live="polite" aria-relevant="additions" aria-labelledby={labelledBy} className="flex flex-col gap-3" data-sp-chat-thread>
      {lead ? <li className="flex flex-col items-start">{lead}</li> : null}
      {messages.map((m, i) => {
        const mine = m.from === 'customer';
        const time = formatDhakaClock(m.created_at) ?? '';
        return (
          <li key={m.id} className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`} data-sp-chat-from={m.from}>
            <span className="sr-only">{mine ? tr(INBOX_COPY.you, lang) : m.author_name}:</span>
            <Bubble from={m.from} tone={tone}>
              {m.body ? <span>{mine ? m.body : <ReplyText text={m.body} />}</span> : null}
              {m.attachments.map((a) => (
                <AttachmentView key={a.id} a={a} url={attachmentUrl(a.id)} mine={mine} lang={lang} />
              ))}
            </Bubble>
            {mine ? (
              <p className="type-body-s flex items-center gap-1 text-ink-muted">
                {tr(INBOX_COPY.sentAt(time), lang)}
                {i === seenIdx ? <span data-sp-chat-seen>· {tr(INBOX_COPY.seen, lang)}</span> : <Icon name="check" size={14} />}
              </p>
            ) : showShopMeta ? (
              <p className="type-body-s text-ink-muted">
                {m.author_name} · {time}
              </p>
            ) : null}
          </li>
        );
      })}
      {pending.map((p) => (
        <li key={p.client_id} className="flex flex-col items-end gap-1" data-sp-chat-pending={p.state}>
          <div className={`type-body-s flex max-w-[85%] flex-col gap-1 rounded-[12px] px-3.5 py-2.5 whitespace-pre-wrap break-words ${p.state === 'failed' ? 'border-2 border-sale bg-surface text-ink' : 'bg-brand text-on-brand opacity-70'}`}>
            {p.body ? <span>{p.body}</span> : null}
            {p.file ? (
              <span className="type-label-s flex items-center gap-1.5">
                <Icon name="paperclip" size={16} />
                {p.file.name}
              </span>
            ) : null}
          </div>
          {p.state === 'failed' ? (
            <button type="button" onClick={() => onRetry(p.client_id)} className="type-body-s text-sale underline" data-sp-chat-retry>
              {tr(INBOX_COPY.notSent, lang)}
            </button>
          ) : (
            <p className="type-body-s text-ink-muted">{tr(INBOX_COPY.sending, lang)}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
