import type { InboxAttachment, InboxConversation, InboxStatus } from '@storeplix/types';
import { isApiError, isImpersonationReadOnly } from '@storeplix/api-client';
import { Button, cn, Dialog, formatBdt, Menu, PaymentStatusBadge, Skeleton } from '@storeplix/ui';
import { AlertCircle, ArrowLeft, Ban, CheckCircle2, ChevronRight, MessageCircle, MoreHorizontal, ShoppingBag, Trash2, UserRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ErrorBlock } from '../catalog/states';
import { READ_ONLY_MESSAGE } from '../impersonation/ApiErrorWatcher';
import { toast } from '../online-store/components/Toast';
import { AssignPopover } from './AssignPopover';
import { Attachments, ContactAvatar, MessageRow, ProductContextCard, StatusPill } from './components';
import { Composer, type ComposerSend } from './Composer';
import { inboxErrorText } from './errors';
import { firstName, lastCustomerMessageId, newClientId, seenByShopper, shouldMarkRead, threadSubline } from './inbox';
import { useAssign, useBlock, useConversation, useDeleteConversation, useLoadEarlier, useMarkRead, useSendMessage, useSetStatus, useThread } from './queries';

// PHASE-8-8E §6, Figma 2118:51165 thread column + mobile 2124:1509: header (back on mobile), action bar (assign,
// status pill, Mark pending, Close / Reopen), linked-order strip on small screens, bottom-anchored messages with
// history, failed sends with "Not sent · Tap to retry" (same client_id), closed / blocked notices, composer.

interface Outgoing extends ComposerSend {
  client_id: string;
  state: 'sending' | 'failed';
  created_at: string;
}

/** Thread placeholder: "Select a conversation" (2122:53073 / 2122:52543). */
export function NoThread({ tip }: { tip: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <MessageCircle aria-hidden className="size-5" />
      </span>
      <p className="text-body-lg font-medium text-text-primary">Select a conversation</p>
      <p className="text-body text-text-secondary">{tip}</p>
    </div>
  );
}

export function ThreadSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border-default px-5 py-3.5">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-40 rounded-full" />
          <Skeleton className="h-2.5 w-56 rounded-full" />
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-4 p-5">
        <Skeleton className="h-16 w-3/5 rounded-[14px]" />
        <Skeleton className="ml-auto h-20 w-1/2 rounded-[14px]" />
        <Skeleton className="h-12 w-2/5 rounded-[14px]" />
      </div>
      <div className="border-t border-border-default p-4">
        <Skeleton className="h-12 w-full rounded-card" />
      </div>
    </div>
  );
}

export function ThreadPane({
  conversationId,
  you,
  readOnly,
  onBack,
  onOpenCustomer,
  onClosed,
  onDeleted,
}: {
  conversationId: string;
  you: string | null;
  readOnly: boolean;
  onBack: () => void;
  onOpenCustomer: () => void;
  onClosed: (c: InboxConversation, previous: InboxStatus) => void;
  onDeleted: () => void;
}) {
  const conversation = useConversation(conversationId);
  const thread = useThread(conversationId);
  const earlier = useLoadEarlier(conversationId);
  const send = useSendMessage(conversationId);
  const assign = useAssign(conversationId);
  const status = useSetStatus(conversationId);
  const block = useBlock(conversationId);
  const remove = useDeleteConversation();
  const markRead = useMarkRead(conversationId);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const marked = useRef<Record<string, string>>({});

  const messages = thread.data?.data.messages ?? [];
  const lastId = messages.at(-1)?.id;
  const lastCustomer = lastCustomerMessageId(messages);

  // Bottom-anchored: follow new rows (not history pages, which keep the last id) and stay pinned while the pane
  // resizes (chips / notices loading) as long as the member hasn't scrolled up.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
  }, [lastId, outgoing.length, conversationId, conversation.isSuccess]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [conversation.isSuccess]);

  // §6.4 read marking (forward only, never in a read-only support session, only while the tab is visible).
  useEffect(() => {
    if (readOnly || !lastCustomer || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    if (!shouldMarkRead(lastCustomer, marked.current[conversationId])) return;
    marked.current[conversationId] = lastCustomer;
    markRead.mutate(lastCustomer);
  }, [conversationId, lastCustomer, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = conversation.data;

  if (conversation.isPending || (thread.isPending && !thread.data)) return <ThreadSkeleton />;
  if (conversation.isError || !c) {
    const gone = isApiError(conversation.error) && conversation.error.status === 404;
    return (
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border-default px-4 py-3 lg:hidden">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft aria-hidden className="size-4" />} onClick={onBack}>
            Inbox
          </Button>
        </div>
        <ErrorBlock
          title={gone ? 'This conversation no longer exists' : 'We couldn’t load this conversation'}
          error={conversation.error}
          message={gone ? 'It may have been deleted. Pick another one from the list.' : undefined}
          onRetry={gone ? undefined : () => void conversation.refetch()}
          className="flex-1 justify-center"
        />
      </div>
    );
  }

  const writable = !readOnly && c.can.reply;
  const conflict = (e: unknown) => toast(inboxErrorText(e), 'error');

  const deliver = (o: Outgoing) => {
    send.mutate(
      { kind: o.kind, body: o.body, attachment_ids: o.attachments.map((a) => a.id), client_id: o.client_id, saved_reply_id: o.saved_reply_id },
      {
        onSuccess: () => setOutgoing((list) => list.filter((x) => x.client_id !== o.client_id)),
        onError: (e) => {
          if (isImpersonationReadOnly(e)) {
            toast(READ_ONLY_MESSAGE, 'error');
            setOutgoing((list) => list.filter((x) => x.client_id !== o.client_id));
            return;
          }
          setOutgoing((list) => list.map((x) => (x.client_id === o.client_id ? { ...x, state: 'failed' } : x)));
        },
      },
    );
  };
  const onSend = (v: ComposerSend) => {
    const o: Outgoing = { ...v, client_id: newClientId(), state: 'sending', created_at: new Date().toISOString() };
    setOutgoing((list) => [...list, o]);
    deliver(o);
  };
  const retry = (o: Outgoing) => {
    setOutgoing((list) => list.map((x) => (x.client_id === o.client_id ? { ...x, state: 'sending' } : x)));
    deliver({ ...o, state: 'sending' });
  };

  const changeStatus = (next: InboxStatus) => {
    const previous = c.status;
    status.mutate(
      { status: next, revision: c.revision },
      {
        onSuccess: (updated) => {
          if (next === 'closed') onClosed(updated, previous);
        },
        onError: conflict,
      },
    );
  };

  const menu = [
    ...(writable && c.status !== 'closed'
      ? [{ key: 'status', label: c.status === 'pending' ? 'Mark open' : 'Mark pending', onSelect: () => changeStatus(c.status === 'pending' ? 'open' : 'pending') }]
      : []),
    ...(writable
      ? [
          c.blocked
            ? { key: 'unblock', label: 'Unblock customer', icon: <Ban aria-hidden className="size-4" />, onSelect: () => block.mutate(false, { onError: conflict }) }
            : { key: 'block', label: 'Block customer', hint: 'Their new messages are dropped', icon: <Ban aria-hidden className="size-4" />, onSelect: () => block.mutate(true, { onError: conflict }) },
        ]
      : []),
    ...(c.can.delete && !readOnly
      ? [{ key: 'delete', label: 'Delete conversation', danger: true, icon: <Trash2 aria-hidden className="size-4" />, onSelect: () => setConfirmDelete(true) }]
      : []),
  ];
  const order = c.customer.linked_order;
  const contactFirst = firstName(c.contact.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border-default bg-surface-card px-4 py-3.5 sm:px-5">
        <button type="button" aria-label="Back to conversations" onClick={onBack} className="-ml-1 rounded-full p-1.5 text-text-primary hover:bg-surface-subtle lg:hidden">
          <ArrowLeft aria-hidden className="size-5" />
        </button>
        <ContactAvatar name={c.contact.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-body font-semibold text-text-primary">{c.contact.name}</h2>
          <p className="truncate text-caption text-text-secondary">{threadSubline(c)}</p>
        </div>
        <button type="button" onClick={onOpenCustomer} aria-label="Customer details" className="hidden rounded-md p-1.5 text-text-secondary hover:bg-surface-subtle lg:inline-flex xl:hidden">
          <UserRound aria-hidden className="size-[18px]" />
        </button>
        {menu.length > 0 && <Menu label="Conversation actions" trigger={<MoreHorizontal aria-hidden className="size-[18px]" />} entries={menu} triggerClassName="rounded-md p-1.5 text-text-secondary hover:bg-surface-subtle" />}
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-default bg-surface-card px-4 py-2.5 sm:px-5">
        <AssignPopover assignee={c.assignee} disabled={readOnly || !c.can.assign} busy={assign.isPending} onAssign={(id) => assign.mutate({ assignee_id: id, revision: c.revision }, { onError: conflict })} />
        <StatusPill status={c.status} />
        {c.blocked && <span className="text-caption font-medium text-danger">Blocked</span>}
        <span className="flex-1" />
        {c.status === 'closed' ? (
          <Button size="sm" variant="secondary" disabled={!writable} loading={status.isPending} onClick={() => changeStatus('open')}>
            Reopen
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="hidden sm:inline-flex" disabled={!writable || status.isPending} onClick={() => changeStatus(c.status === 'pending' ? 'open' : 'pending')}>
              {c.status === 'pending' ? 'Mark open' : 'Mark pending'}
            </Button>
            <Button size="sm" variant="secondary" disabled={!writable} loading={status.isPending} onClick={() => changeStatus('closed')}>
              Close
            </Button>
          </>
        )}
      </div>

      {/* Linked-order strip (mobile 2124:1509; the side panel takes over from xl) */}
      <button type="button" onClick={onOpenCustomer} className="flex items-center gap-2 border-b border-border-default bg-surface-subtle px-4 py-2 text-left xl:hidden">
        {order ? (
          <>
            <ShoppingBag aria-hidden className="size-4 shrink-0 text-text-secondary" />
            <span className="truncate text-body font-semibold whitespace-nowrap text-text-primary">
              {order.number} · {formatBdt(order.total_amount)}
            </span>
            <PaymentStatusBadge status={order.payment_status} />
          </>
        ) : (
          <span className="text-caption text-text-secondary">{c.contact.phone || c.contact.email || 'No order linked'}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 text-caption font-medium text-brand-600">
          Customer <ChevronRight aria-hidden className="size-4" />
        </span>
      </button>

      {/* Messages */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-surface-canvas"
        aria-live="polite"
        aria-label="Messages"
      >
        <div className="flex min-h-full flex-col justify-end gap-3 px-4 py-4 sm:px-5">
          {thread.data?.data.hasMore && (
            <div className="flex justify-center">
              <Button size="sm" variant="ghost" loading={earlier.isPending} onClick={() => earlier.mutate()}>
                Load earlier messages
              </Button>
            </div>
          )}
          {c.context && <ProductContextCard context={c.context} />}
          {thread.isError && !thread.data && <ErrorBlock title="We couldn’t load the messages" error={thread.error} onRetry={() => void thread.refetch()} />}
          {messages.map((m) => (
            <MessageRow key={m.id} m={seenByShopper(m, c.customer_seen_at)} you={you} />
          ))}
          {outgoing.map((o) => (
            <OutgoingRow key={o.client_id} o={o} onRetry={() => retry(o)} />
          ))}
        </div>
      </div>

      {c.status === 'closed' && (
        <p className="mx-4 mb-0 mt-3 flex items-start gap-2 rounded-lg bg-surface-subtle px-3 py-2.5 text-caption text-text-secondary sm:mx-5">
          <CheckCircle2 aria-hidden className="mt-px size-4 shrink-0" />
          Closed. If {contactFirst} writes again it reopens{c.assignee ? ` and goes back to ${firstName(c.assignee.name)}` : ' in the shared queue'}. Replying here reopens it too.
        </p>
      )}
      {c.blocked && (
        <p className="mx-4 mt-3 flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2.5 text-caption text-text-primary sm:mx-5">
          <Ban aria-hidden className="mt-px size-4 shrink-0 text-danger" />
          Blocked. New messages from {contactFirst} are dropped. Unblock from the ⋯ menu.
        </p>
      )}
      {c.identity === 'unverified' && c.channel === 'web_chat' && (
        <p className="mx-4 mt-3 flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-caption text-text-primary sm:mx-5">
          <AlertCircle aria-hidden className="mt-px size-4 shrink-0 text-warning" />
          Number not verified — {contactFirst} sees your reply only in the chat window, and we won’t text them.
        </p>
      )}

      <Composer
        conversationId={c.id}
        channel={c.channel}
        disabled={!writable}
        disabledReason={readOnly ? 'Read-only support session' : undefined}
        onSend={onSend}
      />

      <Dialog
        open={confirmDelete}
        title="Delete this conversation?"
        description={`All messages and attachments with ${c.contact.name} are deleted for everyone. This can’t be undone.`}
        confirmLabel="Delete conversation"
        tone="danger"
        loading={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          remove.mutate(c.id, {
            onSuccess: () => {
              setConfirmDelete(false);
              toast('Conversation deleted.');
              onDeleted();
            },
            onError: (e) => toast(inboxErrorText(e), 'error'),
          })
        }
      />
    </div>
  );
}

function OutgoingRow({ o, onRetry }: { o: Outgoing; onRetry: () => void }) {
  const failed = o.state === 'failed';
  const note = o.kind === 'note';
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          'flex max-w-[85%] flex-col gap-1.5 rounded-[14px] px-3.5 py-2.5 sm:max-w-[75%]',
          failed ? 'border border-danger bg-surface-card text-text-primary' : note ? 'bg-warning-bg text-text-primary opacity-80' : 'bg-brand-500 text-text-inverse opacity-80',
        )}
      >
        <Attachments items={o.attachments as InboxAttachment[]} inverse={!failed && !note} />
        {o.body && <p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{o.body}</p>}
        {failed ? (
          <button type="button" onClick={onRetry} className="self-start text-caption font-medium text-danger hover:underline">
            Not sent · Tap to retry
          </button>
        ) : (
          <span className="text-caption opacity-80">Sending…</span>
        )}
      </div>
    </div>
  );
}
