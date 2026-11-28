import type { SupportAttachment, SupportTicket, SupportTicketMessage } from '@storeplix/types';
import { SUPPORT_LIMITS, SUPPORT_TICKET_CATEGORY_LABELS } from '@storeplix/types';
import { Avatar, Badge, Button, cn, formatBdt, OrderStatusBadge, Skeleton } from '@storeplix/ui';
import { AlertTriangle, Paperclip, Star, X } from 'lucide-react';
import { Fragment, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { NoAccessState } from '../layout/RequirePermission';
import { can } from '../lib/permissions';
import { toast } from '../online-store/components/Toast';
import { AttachmentChip, HelpBreadcrumb, PriorityBadge, TicketStatusBadge } from './components';
import { helpErrorText, isNotFound } from './errors';
import {
  ATTACHMENT_ACCEPT,
  attachmentProblem,
  canContactSupport,
  dayLabel,
  formatBytes,
  formatDuration,
  formatHelpDateTime,
  formatHelpTime,
  newClientId,
  showRatingCard,
  systemRowText,
} from './help';
import { useNewTicket } from './NewTicketModal';
import { useRateTicket, useReplyTicket, useResolveTicket, useTicket, useTicketMessages, useUploadSupportAttachment } from './queries';

// PHASE-8-9C §13 Ticket thread 71:22844 (`/help/tickets/:id`): header T-n + subject + status pill + Mark as solved;
// thread (merchant / staff bubbles, attachments, system rows "Picked up by {name}", "Marked solved", "Reopened",
// "Closed automatically"); rating card when allowed (1–5 + comment, 14 days); reply box with files — a reply on a
// Solved ticket reopens it; closed → "This ticket is closed. Open a new ticket". Side panel: Ticket details, Related
// order (link with `orders.view`), Your shop + "Shared with support" note, Files. Messages poll every 30 s.

export function TicketPage() {
  const { activeTenant } = useAuth();
  if (!canContactSupport(activeTenant)) return <NoAccessState heading="Support ticket" title="Ask your shop owner to contact support" description="Only members who can contact Store Plix support see this shop’s tickets." />;
  return <TicketInner />;
}

function TicketInner() {
  const { ticketId = '' } = useParams();
  const ticket = useTicket(ticketId);
  const messages = useTicketMessages(ticketId, ticket.isSuccess);

  if (ticket.isError)
    return (
      <div className="flex flex-col gap-5">
        <HelpBreadcrumb items={[{ label: 'Support tickets', to: '/help/tickets' }, { label: 'Ticket' }]} />
        <StateCard>
          <ErrorBlock
            title={isNotFound(ticket.error) ? 'This ticket doesn’t exist' : 'Couldn’t load this ticket'}
            message={isNotFound(ticket.error) ? 'It may belong to another shop. Go back to your tickets.' : helpErrorText(ticket.error)}
            onRetry={isNotFound(ticket.error) ? undefined : () => void ticket.refetch()}
          />
        </StateCard>
      </div>
    );
  if (ticket.isPending)
    return (
      <div aria-busy="true" aria-label="Loading ticket" className="flex flex-col gap-5">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-2/3" />
        <div className="flex flex-col gap-5 lg:flex-row">
          <Skeleton className="h-96 flex-1 rounded-card" />
          <Skeleton className="h-72 rounded-card lg:w-[310px]" />
        </div>
      </div>
    );
  const t = ticket.data;
  return (
    <div className="flex flex-col gap-5">
      <HelpBreadcrumb items={[{ label: 'Support tickets', to: '/help/tickets' }, { label: t.reference }]} />
      <Header t={t} />
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <div className="flex flex-col gap-4 p-4 sm:p-6">
            {messages.isPending ? (
              <div aria-busy="true" aria-label="Loading messages" className="flex flex-col gap-4">
                <Skeleton className="ml-auto h-16 w-2/3 rounded-card" />
                <Skeleton className="h-16 w-2/3 rounded-card" />
              </div>
            ) : messages.isError ? (
              <ErrorBlock title="Couldn’t load the messages" message={helpErrorText(messages.error)} onRetry={() => void messages.refetch()} />
            ) : (
              <Thread messages={messages.data} />
            )}
            {showRatingCard(t) && <RatingCard t={t} />}
          </div>
          <ReplyBox t={t} />
        </section>
        <SidePanel t={t} />
      </div>
    </div>
  );
}

function Header({ t }: { t: SupportTicket }) {
  const readOnly = useReadOnly();
  const resolve = useResolveTicket(t.id);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-heading-24 text-text-primary">{t.subject}</h1>
        <p className="text-body text-text-secondary">
          {t.reference} · {SUPPORT_TICKET_CATEGORY_LABELS[t.category]} · opened {formatHelpDateTime(t.created_at)}
          {t.requester ? ` by ${t.requester.name}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <TicketStatusBadge status={t.status} />
        {t.can.resolve && (
          <Button
            variant="secondary"
            disabled={readOnly}
            loading={resolve.isPending}
            onClick={() => resolve.mutate(undefined, { onSuccess: () => toast('Marked as solved.'), onError: (e) => toast(helpErrorText(e), 'error') })}
          >
            Mark as solved
          </Button>
        )}
      </div>
    </div>
  );
}

function Thread({ messages }: { messages: SupportTicketMessage[] }) {
  const days = messages.map((m) => dayLabel(m.created_at));
  return (
    <ol aria-label="Messages" className="flex flex-col gap-4">
      {messages.map((m, i) => (
        <Fragment key={m.id}>
          {days[i] !== days[i - 1] && (
            <li aria-hidden className="flex items-center gap-3 text-caption text-text-muted">
              <span className="h-px flex-1 bg-border-default" />
              {days[i]}
              <span className="h-px flex-1 bg-border-default" />
            </li>
          )}
          <MessageRow m={m} />
        </Fragment>
      ))}
    </ol>
  );
}

function MessageRow({ m }: { m: SupportTicketMessage }) {
  if (m.kind === 'system') {
    const text = systemRowText(m);
    if (!text) return null;
    return (
      <li className="text-center text-caption text-text-muted">
        {text} · {formatHelpTime(m.created_at)}
      </li>
    );
  }
  const mine = m.kind === 'merchant';
  const name = m.author?.name ?? (mine ? 'Your team' : 'Store Plix support');
  const staffName = !mine ? name.split(' · ')[0] : name;
  return (
    <li className={cn('flex gap-3', mine && 'flex-row-reverse')}>
      <Avatar name={staffName} size="sm" />
      <div className={cn('flex max-w-[85%] min-w-0 flex-col gap-1.5 sm:max-w-[75%]', mine && 'items-end')}>
        <span className="flex items-center gap-2 text-caption font-medium text-text-primary">
          {staffName}
          {!mine && (
            <Badge tone="brand" size="sm">
              Store Plix support
            </Badge>
          )}
        </span>
        {m.body && (
          <div className={cn('rounded-card px-3.5 py-2.5 text-body whitespace-pre-wrap break-words', mine ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-primary')}>
            {m.body}
            <span className={cn('mt-1 block text-right text-caption', mine ? 'text-brand-100' : 'text-text-muted')}>{formatHelpTime(m.created_at)}</span>
          </div>
        )}
        {m.attachments.length > 0 && (
          <div className={cn('flex flex-wrap gap-2', mine && 'justify-end')}>
            {m.attachments.map((a) => (
              <AttachmentChip key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/** CSAT card (P89C-17): 1–5 stars + optional comment, changeable while `can.rate`. */
function RatingCard({ t }: { t: SupportTicket }) {
  const readOnly = useReadOnly();
  const rate = useRateTicket(t.id);
  const [editing, setEditing] = useState(!t.rating);
  const [stars, setStars] = useState<number>(t.rating?.rating ?? 0);
  const [comment, setComment] = useState(t.rating?.comment ?? '');
  const commentId = useId();
  const who = t.assignee_name;

  if (t.rating && !editing) {
    return (
      <section aria-label="Your rating" className="flex flex-col items-center gap-2 rounded-card border border-brand-100 bg-brand-50 px-5 py-5 text-center">
        <span className="text-body font-medium text-text-primary">You rated this ticket {t.rating.rating} / 5</span>
        <Stars value={t.rating.rating} />
        {t.rating.comment && <p className="text-body text-text-secondary">“{t.rating.comment}”</p>}
        {t.can.rate && !readOnly && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change rating
          </Button>
        )}
      </section>
    );
  }
  if (!t.can.rate) return null;
  return (
    <section aria-label="Rate this ticket" className="flex flex-col items-center gap-3 rounded-card border border-brand-100 bg-brand-50 px-5 py-6 text-center">
      <h2 className="text-body-lg font-medium text-text-primary">{who ? `How did ${who} do?` : 'How did we do?'}</h2>
      <p className="text-body text-text-secondary">Your rating helps us coach the team. It takes 5 seconds.</p>
      <Stars value={stars} onChange={readOnly ? undefined : setStars} />
      <div className="flex w-full max-w-lg flex-col gap-2 rounded-lg border border-border-default bg-surface-card p-2 sm:flex-row sm:items-center">
        <label htmlFor={commentId} className="sr-only">
          Comment
        </label>
        <input
          id={commentId}
          value={comment}
          maxLength={SUPPORT_LIMITS.ratingComment}
          disabled={readOnly}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment (optional)…"
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-body text-text-primary outline-none placeholder:text-text-muted"
        />
        <Button
          size="sm"
          disabled={readOnly || stars < 1}
          loading={rate.isPending}
          onClick={() =>
            rate.mutate(
              { rating: stars as 1 | 2 | 3 | 4 | 5, comment: comment.trim() || null },
              { onSuccess: () => (setEditing(false), toast('Thanks for rating.')), onError: (e) => toast(helpErrorText(e), 'error') },
            )
          }
        >
          Send rating
        </Button>
      </div>
    </section>
  );
}

function Stars({ value, onChange }: { value: number; onChange?: (n: number) => void }) {
  return (
    <div role={onChange ? 'radiogroup' : 'img'} aria-label={onChange ? 'Rating' : `${value} out of 5`} className="flex gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n <= value;
        const star = <Star aria-hidden className={cn('size-7', on ? 'fill-accent-500 text-accent-500' : 'text-border-strong')} />;
        return onChange ? (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`} onClick={() => onChange(n)} className="rounded outline-none focus-visible:shadow-focus">
            {star}
          </button>
        ) : (
          <span key={n}>{star}</span>
        );
      })}
    </div>
  );
}

interface Upload {
  key: string;
  name: string;
  size: number;
  progress: number;
  attachment: SupportAttachment | null;
}
let uploadSeq = 0;

function ReplyBox({ t }: { t: SupportTicket }) {
  const readOnly = useReadOnly();
  const reply = useReplyTicket(t.id);
  const upload = useUploadSupportAttachment();
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const clientId = useRef(newClientId());
  const fileInput = useRef<HTMLInputElement>(null);
  const areaId = useId();
  const newTicket = useNewTicket({ category: t.category });

  if (t.status === 'closed' || !t.can.reply) {
    return (
      <div className="flex flex-col gap-3 border-t border-border-default p-4 sm:p-6">
        {newTicket.banner}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-text-muted" />
          <p className="flex-1 text-body text-text-secondary">This ticket is closed. Open a new ticket if you still need help.</p>
          <Button size="sm" variant="secondary" disabled={readOnly} onClick={newTicket.open}>
            Open a new ticket
          </Button>
        </div>
        {newTicket.modal}
      </div>
    );
  }

  const uploading = uploads.some((u) => !u.attachment);
  const ready = uploads.flatMap((u) => (u.attachment ? [u.attachment.id] : []));
  const canSend = !readOnly && !uploading && text.trim().length > 0 && text.length <= SUPPORT_LIMITS.body && !reply.isPending;

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    let count = uploads.length;
    for (const file of Array.from(files)) {
      const problem = attachmentProblem(file, count);
      if (problem) {
        toast(`${file.name}: ${problem}`, 'error');
        continue;
      }
      count++;
      const key = `r-${++uploadSeq}`;
      setUploads((l) => [...l, { key, name: file.name, size: file.size, progress: 0, attachment: null }]);
      upload.mutate(
        { file, opts: { onProgress: (f) => setUploads((l) => l.map((u) => (u.key === key ? { ...u, progress: f } : u))) } },
        {
          onSuccess: (a) => setUploads((l) => l.map((u) => (u.key === key ? { ...u, progress: 1, attachment: a } : u))),
          onError: (e) => {
            setUploads((l) => l.filter((u) => u.key !== key));
            toast(`${file.name}: ${helpErrorText(e, 'Upload failed.')}`, 'error');
          },
        },
      );
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const send = () => {
    if (!canSend) return;
    reply.mutate(
      { body: text.trim(), attachment_ids: ready, client_id: clientId.current },
      {
        onSuccess: () => {
          setText('');
          setUploads([]);
          clientId.current = newClientId();
        },
        onError: (e) => toast(helpErrorText(e, 'Couldn’t send your reply. Your text is kept — try again.'), 'error'),
      },
    );
  };

  const solved = t.status === 'resolved';
  return (
    <div className="border-t border-border-default p-4 sm:p-6">
      <div className="flex flex-col gap-2 rounded-lg border border-border-default p-3 focus-within:border-brand-600">
        <label htmlFor={areaId} className="sr-only">
          Reply
        </label>
        <textarea
          id={areaId}
          rows={3}
          value={text}
          disabled={readOnly}
          maxLength={SUPPORT_LIMITS.body}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={readOnly ? 'Read-only support session' : solved ? 'Reply to reopen this ticket…' : 'Write a reply…'}
          className="w-full resize-y bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
        />
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {uploads.map((u) => (
              <span key={u.key} className="flex items-center gap-2 rounded-md bg-surface-subtle px-2.5 py-1.5 text-caption">
                <span className="max-w-40 truncate font-medium text-text-primary">{u.name}</span>
                <span className="text-text-muted">{u.attachment ? formatBytes(u.size) : `${Math.round(u.progress * 100)}%`}</span>
                <button type="button" aria-label={`Remove ${u.name}`} onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))} className="text-text-muted hover:text-text-primary">
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Attach files"
            disabled={readOnly || uploads.length >= SUPPORT_LIMITS.attachmentsPerMessage}
            onClick={() => fileInput.current?.click()}
            className="flex size-8 items-center justify-center rounded-md border border-border-default text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Paperclip aria-hidden className="size-4" />
          </button>
          <span className="flex-1 text-caption text-text-muted">PNG, JPG or PDF up to 10 MB</span>
          <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} className="sr-only" aria-label="Choose files" onChange={(e) => addFiles(e.target.files)} />
          <Button size="sm" disabled={!canSend} loading={reply.isPending} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="text-body text-text-secondary">{label}</dt>
      <dd className="text-right text-body font-medium text-text-primary">{children}</dd>
    </div>
  );
}

function SidePanel({ t }: { t: SupportTicket }) {
  const { activeTenant } = useAuth();
  const ordersView = can.viewOrders(activeTenant);
  const card = t.order_card;
  return (
    <aside className="flex flex-col gap-4 lg:w-[310px] lg:shrink-0">
      <section className="rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
        <h2 className="pb-2 text-body-lg font-medium text-text-primary">Ticket details</h2>
        <dl>
          <Row label="Ticket">{t.reference}</Row>
          <Row label="Category">{SUPPORT_TICKET_CATEGORY_LABELS[t.category]}</Row>
          <Row label="Priority">
            <PriorityBadge priority={t.priority} />
          </Row>
          <Row label="Status">
            <TicketStatusBadge status={t.status} size="sm" />
          </Row>
          <Row label="Assigned to">{t.assignee_name ?? <span className="font-normal text-text-muted">Not yet</span>}</Row>
          <Row label="First reply">{formatDuration(t.first_reply_seconds)}</Row>
          {t.resolution_seconds !== null && <Row label="Resolved in">{formatDuration(t.resolution_seconds)}</Row>}
        </dl>
      </section>

      {t.related_order && (
        <section className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <div className="flex items-center gap-2">
            <h2 className="flex-1 text-body-lg font-medium text-text-primary">Related order</h2>
            {ordersView && t.related_order.id && (
              <Link to={`/orders/${t.related_order.id}`} className="text-caption font-medium text-brand-600 hover:underline">
                Open
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-body font-semibold text-brand-600">{t.related_order.number}</span>
            {card && <OrderStatusBadge status={card.status} />}
          </div>
          {card && (
            <p className="text-caption text-text-secondary">
              Placed {formatHelpDateTime(card.placed_at)} · {formatBdt(card.total_amount)}
            </p>
          )}
          {t.status !== 'closed' && <p className="text-caption text-text-muted">Store Plix support can see this order’s number, status, items and totals while the ticket is open.</p>}
        </section>
      )}

      <section className="flex flex-col gap-1 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
        <h2 className="pb-1 text-body-lg font-medium text-text-primary">Your shop</h2>
        <dl>
          <Row label="Shop">{t.shop.name}</Row>
          {t.shop.domain && <Row label="Domain">{t.shop.domain}</Row>}
        </dl>
        <p className="pt-1 text-caption text-text-muted">Support sees your shop name with every ticket, and only the order you link while the ticket is open.</p>
      </section>

      {t.files.length > 0 && (
        <section className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <h2 className="text-body-lg font-medium text-text-primary">Files</h2>
          <div className="flex flex-col gap-2">
            {t.files.map((f) => (
              <AttachmentChip key={f.id} a={f} />
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

export default TicketPage;
