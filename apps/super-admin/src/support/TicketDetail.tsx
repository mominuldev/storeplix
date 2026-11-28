import { isApiError } from '@storeplix/api-client';
import {
  SUPPORT_LIMITS,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_CATEGORY_LABELS,
  type AdminSupportMessage,
  type AdminSupportReplyInput,
  type AdminSupportTicket,
  type SupportAttachment,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '@storeplix/types';
import { Badge, Button, Card, OrderStatusBadge, Select, cn, formatBdt } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, ExternalLink, Eye, FileText, ImageIcon, Lock, Paperclip, Star, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { saveBlob } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { formatDateTime, planName, providerLabel } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { ImpersonateDialog } from '../merchants/ImpersonateDialog';
import { duration, fileSize, newClientId, PRIORITIES, PRIORITY_LABELS, priorityTone, STAFF_STATUS_LABELS, statusTone, waiting } from './format';
import { supportKeys, THREAD_POLL_MS, useSupportAssignees } from './queries';

const STATUSES: SupportTicketStatus[] = ['open', 'awaiting_support', 'awaiting_merchant', 'resolved', 'closed'];
const ATTACH_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

function systemText(m: AdminSupportMessage): string {
  const meta = m.system?.meta ?? {};
  const actor = (meta.actor_name as string | null) ?? (m.author?.name ?? 'Store Plix');
  switch (m.system?.event) {
    case 'created':
      return `${actor} opened the ticket`;
    case 'assigned':
      return `${actor} assigned it to ${(meta.assignee_name as string | null) ?? 'someone'}`;
    case 'unassigned':
      return `${actor} unassigned it`;
    case 'status_changed': {
      const to = meta.to as SupportTicketStatus | undefined;
      return `${actor} changed status to ${to ? STAFF_STATUS_LABELS[to] : 'a new status'}`;
    }
    case 'priority_changed':
      return `${actor} changed priority ${meta.from ? `${PRIORITY_LABELS[meta.from as SupportTicketPriority]} → ` : 'to '}${meta.to ? PRIORITY_LABELS[meta.to as SupportTicketPriority] : ''}`;
    case 'category_changed':
      return `${actor} changed the topic to ${meta.to ? SUPPORT_TICKET_CATEGORY_LABELS[meta.to as SupportTicketCategory] : 'another topic'}`;
    case 'reopened':
      return 'The merchant replied, so the ticket reopened';
    case 'rated':
      return `The merchant rated the help ${meta.rating ?? ''}/5`;
    case 'auto_closed':
      return 'Closed automatically 7 days after it was resolved';
    default:
      return 'Ticket updated';
  }
}

function AttachmentChip({ ticketId, a }: { ticketId: string; a: SupportAttachment }) {
  const toast = useToast();
  const open = useMutation({
    mutationFn: () => api.admin.support.downloadAttachment(ticketId, a.id),
    onSuccess: (f) => saveBlob(f.blob, f.filename || a.filename),
    onError: (e) => toast(errorMessage(e), 'danger'),
  });
  const Icon = a.kind === 'pdf' ? FileText : ImageIcon;
  return (
    <button
      type="button"
      onClick={() => open.mutate()}
      disabled={open.isPending || a.status === 'processing'}
      aria-label={`Download ${a.filename}`}
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border-default bg-surface-card px-2 py-1 text-caption text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus disabled:opacity-60"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{a.filename}</span>
      <span className="shrink-0 text-text-muted">· {a.status === 'processing' ? 'processing' : fileSize(a.size_bytes)}</span>
    </button>
  );
}

function Message({ m, ticketId }: { m: AdminSupportMessage; ticketId: string }) {
  if (m.kind === 'system') {
    return (
      <li className="flex justify-center px-4 text-center text-caption text-text-muted">
        {systemText(m)} · {formatDateTime(m.created_at)}
      </li>
    );
  }
  const staff = m.kind === 'staff';
  const note = m.kind === 'note';
  return (
    <li className={cn('flex flex-col gap-1', staff ? 'items-end' : 'items-start', note && 'items-stretch')}>
      <span className="flex items-center gap-1.5 text-caption text-text-muted">
        {note && <Lock aria-hidden className="size-3 text-warning" />}
        <span className={cn('font-medium', note ? 'text-warning' : 'text-text-primary')}>
          {note ? `Internal note · ${m.author?.name ?? 'Staff'}` : m.author?.name ?? 'Merchant'}
        </span>
        {formatDateTime(m.created_at)}
      </span>
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-2 rounded-lg px-3.5 py-2.5 text-body',
          staff && 'bg-brand-600 text-text-inverse',
          m.kind === 'merchant' && 'border border-border-default bg-surface-card text-text-primary',
          note && 'max-w-full border border-dashed border-warning bg-warning-bg text-text-primary',
        )}
      >
        {m.body && <p className="whitespace-pre-line">{m.body}</p>}
        {m.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {m.attachments.map((a) => (
              <AttachmentChip key={a.id} ticketId={ticketId} a={a} />
            ))}
          </div>
        )}
        {note && <span className="text-caption text-warning">Only staff can see this</span>}
      </div>
    </li>
  );
}

type NextStatus = NonNullable<AdminSupportReplyInput['status']>;

function Composer({ ticket }: { ticket: AdminSupportTicket }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [next, setNext] = useState<NextStatus>('awaiting_merchant');
  const [files, setFiles] = useState<SupportAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const clientId = useRef(newClientId());
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (f: File) => api.admin.support.uploadAttachment(ticket.id, { file: f, filename: f.name }),
    onSuccess: (a) => setFiles((all) => [...all, a]),
    onError: (e) => setFileError(errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: () =>
      api.admin.support.reply(ticket.id, { kind, body: body.trim(), attachment_ids: files.map((f) => f.id), client_id: clientId.current, status: kind === 'reply' ? next : undefined }),
    onSuccess: () => {
      setBody('');
      setFiles([]);
      clientId.current = newClientId();
      void queryClient.invalidateQueries({ queryKey: supportKeys.messages(ticket.id) });
      void queryClient.invalidateQueries({ queryKey: supportKeys.ticket(ticket.id) });
      void queryClient.invalidateQueries({ queryKey: supportKeys.list });
      toast(kind === 'note' ? 'Internal note added' : 'Reply sent — the merchant gets an email');
    },
  });

  if (!ticket.can.reply) {
    return <p className="rounded-md bg-surface-subtle px-4 py-3 text-body text-text-secondary">This ticket is closed. The merchant has to open a new ticket to continue.</p>;
  }

  const pick = (list: FileList | null) => {
    setFileError(null);
    for (const f of Array.from(list ?? [])) {
      if (files.length + (upload.isPending ? 1 : 0) >= SUPPORT_LIMITS.attachmentsPerMessage) {
        setFileError(`Up to ${SUPPORT_LIMITS.attachmentsPerMessage} files per message.`);
        break;
      }
      if (!ATTACH_TYPES.includes(f.type)) {
        setFileError('Attach JPG, PNG or PDF files.');
        continue;
      }
      if (f.size > SUPPORT_LIMITS.attachmentBytes) {
        setFileError('Files can be up to 10 MB.');
        continue;
      }
      upload.mutate(f);
    }
    if (input.current) input.current.value = '';
  };
  const note = kind === 'note';
  const tooLong = body.length > SUPPORT_LIMITS.body;

  return (
    <form
      aria-label={note ? 'Internal note' : 'Reply to merchant'}
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim() && !tooLong) send.mutate();
      }}
      className={cn('flex flex-col rounded-lg border bg-surface-card', note ? 'border-warning' : 'border-border-default')}
    >
      <div role="tablist" aria-label="Message type" className="flex gap-4 border-b border-border-default px-4">
        {(['reply', 'note'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn('border-b-2 py-2.5 text-caption font-medium outline-none focus-visible:shadow-focus', kind === k ? 'border-brand-600 text-text-primary' : 'border-transparent text-text-secondary')}
          >
            {k === 'reply' ? 'Reply to merchant' : 'Internal note'}
          </button>
        ))}
      </div>
      <textarea
        aria-label={note ? 'Note text' : 'Reply text'}
        value={body}
        rows={4}
        onChange={(e) => setBody(e.target.value)}
        placeholder={note ? 'Only staff can see this note. It is never emailed or shown to the merchant.' : 'Write a reply in Bangla or English…'}
        className={cn('resize-y bg-transparent px-4 py-3 text-body text-text-primary outline-none placeholder:text-text-muted', note && 'bg-warning-bg/40')}
      />
      {(files.length > 0 || upload.isPending || fileError || tooLong || send.isError) && (
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => (
              <span key={f.id} className="flex items-center gap-1 rounded-md bg-surface-subtle px-2 py-1 text-caption text-text-secondary">
                {f.filename}
                <button type="button" aria-label={`Remove ${f.filename}`} onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))} className="rounded-sm text-text-muted hover:text-danger">
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            ))}
            {upload.isPending && <span className="text-caption text-text-muted">Uploading…</span>}
          </div>
          {fileError && <p className="text-caption text-danger">{fileError}</p>}
          {tooLong && <p className="text-caption text-danger">Keep the message under {SUPPORT_LIMITS.body.toLocaleString('en-US')} characters.</p>}
          {send.isError && (
            <p role="alert" className="text-caption text-danger">
              {errorMessage(send.error)}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-default px-3 py-2.5">
        <input ref={input} type="file" accept={ATTACH_TYPES.join(',')} multiple hidden aria-label="Attach files" onChange={(e) => pick(e.target.files)} />
        <button type="button" aria-label="Attach file" onClick={() => input.current?.click()} className="rounded-md p-1.5 text-text-muted outline-none hover:bg-surface-subtle hover:text-text-primary focus-visible:shadow-focus">
          <Paperclip aria-hidden className="size-4" />
        </button>
        <span className="flex-1" />
        {!note && (
          <label className="flex items-center gap-1.5 text-caption text-text-secondary">
            Then set
            <select
              aria-label="Status after sending"
              value={next}
              onChange={(e) => setNext(e.target.value as NextStatus)}
              className="rounded-md border border-border-default bg-surface-card px-2 py-1 text-caption text-text-primary outline-none focus-visible:shadow-focus"
            >
              <option value="awaiting_merchant">Waiting on merchant</option>
              <option value="awaiting_support">Waiting on us</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
        )}
        <Button type="submit" size="sm" loading={send.isPending} disabled={!body.trim() || tooLong || upload.isPending}>
          {note ? 'Add note' : 'Send reply'}
        </Button>
      </div>
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-body">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-right text-text-primary">{children}</dd>
    </div>
  );
}

function SidePanel({ ticket }: { ticket: AdminSupportTicket }) {
  const can = useCan();
  const queryClient = useQueryClient();
  const toast = useToast();
  const assignees = useSupportAssignees();
  const [impersonate, setImpersonate] = useState(false);
  const onDone = (t: AdminSupportTicket) => {
    queryClient.setQueryData(supportKeys.ticket(t.id), t);
    void queryClient.invalidateQueries({ queryKey: supportKeys.messages(t.id) });
    void queryClient.invalidateQueries({ queryKey: supportKeys.list });
    void queryClient.invalidateQueries({ queryKey: supportKeys.waiting });
  };
  const onError = (e: unknown) => {
    if (isApiError(e) && e.code === 'revision_conflict') void queryClient.invalidateQueries({ queryKey: supportKeys.ticket(ticket.id) });
    toast(errorMessage(e), 'danger');
  };
  const assign = useMutation({ mutationFn: (assigneeId: string | null) => api.admin.support.assign(ticket.id, { assignee_id: assigneeId, revision: ticket.revision }), onSuccess: onDone, onError });
  const patch = useMutation({
    mutationFn: (input: { priority?: SupportTicketPriority; category?: SupportTicketCategory }) => api.admin.support.update(ticket.id, { ...input, revision: ticket.revision }),
    onSuccess: onDone,
    onError,
  });
  const o = ticket.order_card;
  const busy = assign.isPending || patch.isPending;

  return (
    <aside aria-label="Merchant context" className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-body-lg font-semibold text-text-primary">{ticket.shop.store_name ?? ticket.shop.tenant_name}</h3>
          {ticket.shop.domain && <span className="text-caption text-text-muted">{ticket.shop.domain}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge size="sm" tone="brand">
            {planName(ticket.shop.plan)} plan
          </Badge>
          <Badge size="sm" tone={ticket.shop.tenant_status === 'active' ? 'success' : 'danger'}>
            {planName(ticket.shop.tenant_status)}
          </Badge>
        </div>
        <p className="text-caption text-text-secondary">
          Requester: {ticket.requester?.name ?? 'Former member'}
          {ticket.requester_email ? ` · ${ticket.requester_email}` : ''}
        </p>
        {can('impersonate') && (
          <Button variant="secondary" size="sm" leftIcon={<Eye aria-hidden className="size-4" />} onClick={() => setImpersonate(true)}>
            Impersonate (audited)
          </Button>
        )}
        <Link to={`/merchants/${ticket.shop.tenant_id}`} className="flex items-center justify-center gap-1 text-body font-medium text-brand-600 hover:underline">
          Open merchant profile
          <ExternalLink aria-hidden className="size-3.5" />
        </Link>
      </Card>

      {ticket.related_order && (
        <Card className="flex flex-col gap-2 p-4">
          <h3 className="text-body font-semibold text-text-primary">Related order</h3>
          {o ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-body font-semibold text-text-primary">#{o.number}</span>
                <OrderStatusBadge status={o.status} />
              </div>
              <dl className="flex flex-col gap-1.5">
                <Row label="Placed">{formatDateTime(o.placed_at)}</Row>
                <Row label="Total">{formatBdt(o.total_amount)}</Row>
                <Row label="Paid · due">
                  {formatBdt(o.paid_amount)} · {formatBdt(o.due_amount)}
                </Row>
                <Row label="Payment">
                  {planName(o.payment_status)}
                  {o.payment_method ? ` · ${o.payment_method === 'cod' ? 'COD' : providerLabel(o.payment_method)}` : ''}
                </Row>
                <Row label="Items">
                  {o.items_count}
                  {o.first_item_name ? ` · ${o.first_item_name}` : ''}
                </Row>
                {o.courier && (
                  <Row label="Courier">
                    {planName(o.courier.provider)}
                    {o.courier.status ? ` · ${planName(o.courier.status)}` : ''}
                  </Row>
                )}
                <Row label="Customer">{[o.customer.first_name, o.customer.district].filter(Boolean).join(' · ') || '—'}</Row>
              </dl>
              <p className="flex items-center gap-1.5 text-caption text-text-muted">
                <Eye aria-hidden className="size-3.5" />
                Shared by the merchant · your view is audited
              </p>
            </>
          ) : (
            <p className="text-body text-text-secondary">
              Order #{ticket.related_order.number}
              <span className="block text-caption text-text-muted">{ticket.status === 'closed' ? 'Details are hidden once the ticket is closed.' : 'The order is no longer available.'}</span>
            </p>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <h3 className="text-body font-semibold text-text-primary">Ticket</h3>
        <Select
          label="Assignee"
          value={ticket.assignee?.id ?? ''}
          disabled={busy || !ticket.can.assign}
          onChange={(e) => assign.mutate(e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {ticket.assignee && !assignees.data?.some((a) => a.user.id === ticket.assignee!.id) && <option value={ticket.assignee.id}>{ticket.assignee.name}</option>}
          {(assignees.data ?? []).map((a) => (
            <option key={a.user.id} value={a.user.id}>
              {a.is_you ? `${a.user.name} (you)` : a.user.name} · {a.open_count} open
            </option>
          ))}
        </Select>
        <Select label="Priority" value={ticket.priority} disabled={busy} onChange={(e) => patch.mutate({ priority: e.target.value as SupportTicketPriority })}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <Select label="Topic" value={ticket.category} disabled={busy} onChange={(e) => patch.mutate({ category: e.target.value as SupportTicketCategory })}>
          {SUPPORT_TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {SUPPORT_TICKET_CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h3 className="text-body font-semibold text-text-primary">Timeline</h3>
        <dl className="flex flex-col gap-1.5">
          <Row label="Opened">{formatDateTime(ticket.created_at)}</Row>
          {ticket.waiting_since && <Row label="Waiting since">{formatDateTime(ticket.waiting_since)}</Row>}
          <Row label="First reply">{ticket.first_staff_reply_at ? `${formatDateTime(ticket.first_staff_reply_at)} (${duration(ticket.first_reply_seconds, true)})` : 'Not yet'}</Row>
          {ticket.last_staff_reply_at && <Row label="Last staff reply">{formatDateTime(ticket.last_staff_reply_at)}</Row>}
          {ticket.last_merchant_reply_at && <Row label="Last merchant reply">{formatDateTime(ticket.last_merchant_reply_at)}</Row>}
          {ticket.resolved_at && <Row label="Resolved">{`${formatDateTime(ticket.resolved_at)} (${duration(ticket.resolution_seconds, true)})`}</Row>}
          {ticket.closed_at && <Row label="Closed">{formatDateTime(ticket.closed_at)}</Row>}
          {ticket.reopened_count > 0 && <Row label="Reopened">{`${ticket.reopened_count}×`}</Row>}
        </dl>
        <p className="text-caption text-text-muted">Timestamps only — no reply targets yet.</p>
      </Card>

      {ticket.rating && (
        <Card className="flex flex-col gap-1.5 p-4">
          <h3 className="text-body font-semibold text-text-primary">Rating</h3>
          <span className="flex items-center gap-0.5" aria-label={`Rated ${ticket.rating.rating} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} aria-hidden className={cn('size-4', n <= ticket.rating!.rating ? 'fill-warning text-warning' : 'text-border-strong')} />
            ))}
          </span>
          {ticket.rating.comment && <p className="text-body text-text-secondary">“{ticket.rating.comment}”</p>}
        </Card>
      )}

      {ticket.files.length > 0 && (
        <Card className="flex flex-col gap-2 p-4">
          <h3 className="text-body font-semibold text-text-primary">Files</h3>
          <div className="flex flex-col items-start gap-1.5">
            {ticket.files.map((f) => (
              <AttachmentChip key={f.id} ticketId={ticket.id} a={f} />
            ))}
          </div>
        </Card>
      )}

      {impersonate && <ImpersonateDialog tenant={{ id: ticket.shop.tenant_id, name: ticket.shop.store_name ?? ticket.shop.tenant_name }} ticketRef={ticket.reference} onClose={() => setImpersonate(false)} />}
    </aside>
  );
}

// Ticket thread + merchant context (39:15432 middle and right columns).
export function TicketDetail({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const ticket = useQuery({ queryKey: supportKeys.ticket(ticketId), queryFn: () => api.admin.support.get(ticketId), refetchInterval: THREAD_POLL_MS });
  const messages = useQuery({ queryKey: supportKeys.messages(ticketId), queryFn: () => api.admin.support.messages(ticketId), refetchInterval: THREAD_POLL_MS });
  const setStatus = useMutation({
    mutationFn: (status: SupportTicketStatus) => api.admin.support.setStatus(ticketId, { status, revision: ticket.data?.revision }),
    onSuccess: (t) => {
      queryClient.setQueryData(supportKeys.ticket(t.id), t);
      void queryClient.invalidateQueries({ queryKey: supportKeys.messages(t.id) });
      void queryClient.invalidateQueries({ queryKey: supportKeys.list });
      void queryClient.invalidateQueries({ queryKey: supportKeys.waiting });
      toast(`Status: ${STAFF_STATUS_LABELS[t.status]}`);
    },
    onError: (e) => toast(errorMessage(e), 'danger'),
  });

  if (ticket.isPending)
    return (
      <Card>
        <LoadingRows label="Loading ticket" rows={6} />
      </Card>
    );
  if (ticket.isError)
    return (
      <Card>
        {isApiError(ticket.error) && ticket.error.status === 404 ? (
          <Empty title="This ticket doesn’t exist" description="It may have been deleted after its retention period." />
        ) : (
          <ErrorState error={ticket.error} onRetry={() => void ticket.refetch()} />
        )}
      </Card>
    );

  const t = ticket.data;
  const w = t.status === 'open' || t.status === 'awaiting_support' ? waiting(t.waiting_since) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section aria-label={`Ticket ${t.reference}`} className="flex min-w-0 flex-col self-start overflow-hidden rounded-card border border-border-default bg-surface-card">
        <header className="flex flex-col gap-2 border-b border-border-default px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <h2 className="text-body-lg font-semibold text-text-primary">{t.subject}</h2>
              <span className="text-caption text-text-muted">
                {t.reference} · {t.shop.store_name ?? t.shop.tenant_name} · {SUPPORT_TICKET_CATEGORY_LABELS[t.category]} · opened {formatDateTime(t.created_at)}
              </span>
            </div>
            <label className="flex items-center gap-1.5 text-caption text-text-secondary">
              Status
              <select
                aria-label="Change status"
                value={t.status}
                disabled={!t.can.set_status || setStatus.isPending || t.status === 'closed'}
                onChange={(e) => setStatus.mutate(e.target.value as SupportTicketStatus)}
                className="rounded-md border border-border-default bg-surface-card px-2 py-1.5 text-caption text-text-primary outline-none focus-visible:shadow-focus"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STAFF_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {w && (
              <Badge size="sm" tone={w.tone}>
                <Clock aria-hidden className="size-3" />
                {w.label}
              </Badge>
            )}
            <Badge size="sm" tone={priorityTone[t.priority]}>
              {PRIORITY_LABELS[t.priority]}
            </Badge>
            <Badge size="sm" dot tone={statusTone[t.status]}>
              {STAFF_STATUS_LABELS[t.status]}
            </Badge>
            <span className="flex-1" />
            <span className="text-caption text-text-secondary">{t.assignee ? `Assigned to ${t.assignee.name}` : 'Unassigned'}</span>
          </div>
        </header>
        <div className="flex flex-col gap-4 px-5 py-4">
          {messages.isPending ? (
            <LoadingRows label="Loading messages" rows={4} />
          ) : messages.isError ? (
            <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
          ) : messages.data.length === 0 ? (
            <Empty title="No messages yet" />
          ) : (
            <ol aria-label="Messages" className="flex flex-col gap-4">
              {messages.data.map((m) => (
                <Message key={m.id} m={m} ticketId={t.id} />
              ))}
            </ol>
          )}
        </div>
        <div className="border-t border-border-default bg-surface-canvas px-5 py-4">
          <Composer key={t.id} ticket={t} />
        </div>
      </section>
      <SidePanel ticket={t} />
    </div>
  );
}
