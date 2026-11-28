import type { InboxAttachment, InboxChannel, InboxMessage, InboxProductContext, InboxStatus } from '@storeplix/types';
import { Badge, cn, formatBdt, Spinner } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, Globe, ImageOff, Lock, Mail, ShoppingBag, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useStoreScope } from '../catalog/scope';
import { useReadOnly } from '../impersonation/hooks';
import { toast } from '../online-store/components/Toast';
import { inboxErrorText } from './errors';
import { attachmentSub, clockTime, firstName, replyStatus, STATUS_LABELS, STATUS_TONES, systemText } from './inbox';
import { fetchAttachmentLink, useAttachmentLink } from './queries';

// PHASE-8-8E Figma 2118:51165 building blocks: channel icon, status pill, bubbles (customer / shop / internal note),
// system rows, attachments (signed 5-minute links), product context card.

const CHANNEL_ICONS = { web_chat: Globe, order: ShoppingBag, email: Mail } as const;
const CHANNEL_NAMES: Record<InboxChannel, string> = { web_chat: 'Website chat', order: 'Order message', email: 'Email' };

export function ChannelIcon({ channel, className }: { channel: InboxChannel; className?: string }) {
  const Icon = CHANNEL_ICONS[channel];
  return <Icon role="img" aria-label={CHANNEL_NAMES[channel]} className={cn('size-3.5 shrink-0 text-text-secondary', className)} />;
}

export function StatusPill({ status }: { status: InboxStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot size="sm">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** Contact avatar (Figma 40 px, brand-100 / brand-600 initials). */
export function ContactAvatar({ name, size = 40, className }: { name: string; size?: 22 | 40 | 44; className?: string }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-medium text-brand-600',
        size === 22 ? 'size-[22px] text-[10px]' : size === 44 ? 'size-11 text-caption' : 'size-10 text-caption',
        className,
      )}
    >
      {initials}
    </span>
  );
}

async function openLink(qc: ReturnType<typeof useQueryClient>, scope: ReturnType<typeof useStoreScope>, a: InboxAttachment) {
  try {
    const link = await fetchAttachmentLink(qc, scope, a.id);
    window.open(link.url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    toast(inboxErrorText(e, 'We couldn’t open this file.'), 'error');
  }
}

/** PDF card (Figma "Attachment · PDF"): icon badge, name, "PDF · 214 KB", download. */
function FileCard({ a, inverse }: { a: InboxAttachment; inverse?: boolean }) {
  const qc = useQueryClient();
  const scope = useStoreScope();
  const readOnly = useReadOnly();
  return (
    <div className={cn('flex max-w-full items-center gap-3 rounded-control border p-2 pr-3', inverse ? 'border-transparent bg-surface-card/15' : 'border-border-default bg-surface-card')}>
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', inverse ? 'bg-surface-card/20' : 'bg-surface-subtle')}>
        <FileText aria-hidden className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium">{a.filename}</span>
        <span className={cn('text-caption', inverse ? 'opacity-80' : 'text-text-muted')}>{attachmentSub(a)}</span>
      </span>
      {readOnly ? (
        <span className="text-caption opacity-80">Hidden</span>
      ) : (
        <button type="button" aria-label={`Download ${a.filename}`} onClick={() => void openLink(qc, scope, a)} className="ml-1 rounded-md p-1 outline-none hover:bg-surface-subtle/40 focus-visible:shadow-focus">
          <Download aria-hidden className="size-[18px]" />
        </button>
      )}
    </div>
  );
}

/** Photo: loads its signed link for the preview; click opens the full image. */
function PhotoAttachment({ a }: { a: InboxAttachment }) {
  const qc = useQueryClient();
  const scope = useStoreScope();
  const readOnly = useReadOnly();
  const ready = a.status === 'ready';
  const link = useAttachmentLink(a.id, ready && !readOnly);
  const [broken, setBroken] = useState(false);
  if (readOnly || !ready || link.isError || broken) {
    return (
      <div className="flex h-24 w-44 flex-col items-center justify-center gap-1 rounded-control bg-surface-subtle px-3 text-center text-caption text-text-secondary">
        {!ready ? <Spinner className="size-4" /> : <ImageOff aria-hidden className="size-4" />}
        <span className="truncate">{readOnly ? 'Photos are hidden in a support session' : !ready ? 'Processing photo…' : a.filename}</span>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => void openLink(qc, scope, a)} aria-label={`Open ${a.filename}`} className="block overflow-hidden rounded-control outline-none focus-visible:shadow-focus">
      {link.data ? (
        <img src={link.data.url} alt={a.filename} onError={() => setBroken(true)} className="h-[120px] w-[180px] object-cover" />
      ) : (
        <span className="block h-[120px] w-[180px] animate-pulse bg-surface-subtle" />
      )}
    </button>
  );
}

export function Attachments({ items, inverse }: { items: InboxAttachment[]; inverse?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((a) => (a.kind === 'image' ? <PhotoAttachment key={a.id} a={a} /> : <FileCard key={a.id} a={a} inverse={inverse} />))}
    </div>
  );
}

export function ProductContextCard({ context }: { context: InboxProductContext }) {
  return (
    <div className="flex items-center gap-3 rounded-control bg-surface-subtle p-2 pr-3">
      {context.image_url ? (
        <img src={context.image_url} alt="" className="size-11 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="size-11 shrink-0 rounded-md bg-surface-card" aria-hidden />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-text-primary">{context.name}</span>
        <span className="text-caption text-text-secondary">Asked from this product · {formatBdt(context.price_amount)}</span>
      </span>
    </div>
  );
}

/** One thread row: customer (left, card), reply (right, brand), note (right, warning-bg), system (centred pill). */
export function MessageRow({ m, you }: { m: InboxMessage; you: string | null }) {
  if (m.kind === 'system') {
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-surface-subtle px-3 py-1 text-caption text-text-secondary">
          {m.system?.event === 'closed' ? <Check aria-hidden className="size-3.5" /> : <UserCheck aria-hidden className="size-3.5" />}
          {systemText(m, you)} · {clockTime(m.created_at)}
        </span>
      </div>
    );
  }
  const author = m.author ? (m.author.id === you ? 'You' : firstName(m.author.name)) : null;
  if (m.kind === 'note') {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col gap-1.5 rounded-[14px] bg-warning-bg px-3.5 py-2.5 text-text-primary sm:max-w-[75%]">
          <span className="flex items-center gap-1.5 text-caption font-medium text-warning">
            <Lock aria-hidden className="size-3.5" /> Internal note · only your team sees this
          </span>
          {m.body && <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>}
          <Attachments items={m.attachments} />
          <span className="text-caption text-text-muted">
            {clockTime(m.created_at)}
            {author && ` · ${author}`}
          </span>
        </div>
      </div>
    );
  }
  if (m.kind === 'reply') {
    const status = replyStatus(m);
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] flex-col gap-1.5 rounded-[14px] bg-brand-500 px-3.5 py-2.5 text-text-inverse sm:max-w-[75%]">
          <Attachments items={m.attachments} inverse />
          {m.body && <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>}
          <span className="text-caption opacity-80">
            {clockTime(m.created_at)}
            {author && ` · ${author}`}
            {status && <span className={cn(status.danger && 'font-semibold')}> · {status.text}</span>}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[85%] flex-col gap-1.5 rounded-[14px] border border-border-default bg-surface-card px-3.5 py-2.5 text-text-primary sm:max-w-[75%]">
        <Attachments items={m.attachments} />
        {m.body && <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>}
        <span className="text-caption text-text-muted">{clockTime(m.created_at)}</span>
      </div>
    </div>
  );
}
