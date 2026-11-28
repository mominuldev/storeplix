import type { InboxConversation, InboxConversationSummary, InboxStatus } from '@storeplix/types';
import { Button, buttonVariants, cn, Drawer } from '@storeplix/ui';
import { CheckCircle2, MessageSquareText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { useReadOnly } from '../impersonation/hooks';
import { toast } from '../online-store/components/Toast';
import { ChannelsDrawer, FirstRun } from './Channels';
import { ConversationRow, ListEmpty, ListError, ListHeader, ListSkeleton } from './ConversationList';
import { CustomerPanel } from './CustomerPanel';
import { inboxErrorText } from './errors';
import { canEditChannels, hasListFilters, inboxSearch, listFilters, parseInboxUrl, type InboxUrlState } from './inbox';
import { fetchListPage, useConversation, useConversationList, useInboxSummary, useLinkOrder, useRestoreStatus } from './queries';
import { NoThread, ThreadPane } from './Thread';

// PHASE-8-8E §5–§7, §12; Figma 2118:51165 (list 320 · thread · side panel 360), 2121:51977 (close + Undo), 2122:51964
// loading, 2122:52543 error, 2122:53073 all caught up, 2123:52602 first run; mobile 2124:1335 list / 2124:1509 thread
// (one pane at a time; the side panel opens as a sheet). URL: /inbox?c=<id>&status=&scope=&channel=&q=.

const NEXT_DELAY_MS = 5000;

export function InboxPage() {
  const { activeTenant, user } = useAuth();
  const readOnly = useReadOnly();
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseInboxUrl(params), [params]);
  const update = useCallback(
    (patch: Partial<InboxUrlState>) => setParams((prev) => inboxSearch({ ...parseInboxUrl(prev), ...patch }), { replace: 'q' in patch && Object.keys(patch).length === 1 }),
    [setParams],
  );

  const filters = useMemo(() => listFilters(state), [state.status, state.scope, state.channel, state.q]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useConversationList(filters);
  const summary = useInboxSummary();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);

  // "Load more": later pages are fetched on demand (the first page keeps polling).
  const filterKey = JSON.stringify(filters);
  const [moreState, setMore] = useState<{ key: string; rows: InboxConversationSummary[]; cursor: string | null; loading: boolean }>({ key: filterKey, rows: [], cursor: null, loading: false });
  // pages loaded for other filters are ignored
  const more = moreState.key === filterKey ? moreState : { key: filterKey, rows: [], cursor: null, loading: false };
  const page = list.data?.data;
  const nextCursor = more.cursor ?? page?.meta.next_cursor ?? null;
  const rows = useMemo(() => {
    const first = page?.data ?? [];
    const seen = new Set(first.map((r) => r.id));
    return [...first, ...more.rows.filter((r) => !seen.has(r.id))];
  }, [page, more.rows]);
  const loadMore = async () => {
    if (!nextCursor) return;
    setMore({ ...more, loading: true });
    try {
      const r = await fetchListPage(scope.storeId!, filters, nextCursor);
      setMore({ key: filterKey, rows: [...more.rows, ...(r?.data ?? [])], cursor: r?.meta.next_cursor ?? null, loading: false });
    } catch (e) {
      setMore({ ...more, loading: false });
      toast(inboxErrorText(e, 'We couldn’t load more conversations.'), 'error');
    }
  };

  const selected = useConversation(state.conversation);
  const linkOrder = useLinkOrder(state.conversation);

  // Close + Undo (2121:51977): toast for 5 s, then move on to the next open conversation.
  const [closed, setClosed] = useState<{ conversation: InboxConversation; previous: InboxStatus } | null>(null);
  const undo = useRestoreStatus();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // latest rows / URL state for the 5-second timer
  const latest = useRef({ rows, state });
  useEffect(() => {
    latest.current = { rows, state };
  });
  const onClosed = (c: InboxConversation, previous: InboxStatus) => {
    if (timer.current) clearTimeout(timer.current);
    setClosed({ conversation: c, previous });
    timer.current = setTimeout(() => {
      setClosed(null);
      const s = latest.current.state;
      if (s.conversation !== c.id || s.status === 'closed') return;
      const next = latest.current.rows.find((r) => r.id !== c.id && r.status === s.status);
      update({ conversation: next?.id ?? null });
    }, NEXT_DELAY_MS);
  };
  const onUndo = () => {
    if (!closed) return;
    if (timer.current) clearTimeout(timer.current);
    undo.mutate({ id: closed.conversation.id, status: closed.previous }, { onError: (e) => toast(inboxErrorText(e), 'error') });
    setClosed(null);
  };

  const counts = page?.meta.counts;
  const firstRun = !!page && !!counts && counts.open + counts.pending + counts.closed === 0 && !hasListFilters(state) && (summary.data ? summary.data.open + summary.data.pending === 0 : true);
  const hasThread = !!state.conversation;
  const select = (id: string) => update({ conversation: id });

  const header = (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', hasThread && 'hidden lg:flex')}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-heading-24 text-text-primary">Inbox</h1>
        <p className="text-body text-text-secondary">
          {summary.data ? (
            <>
              <span className="lg:hidden">
                {summary.data.unread} unread · {summary.data.open} open
              </span>
              <span className="hidden lg:inline">Website chat, order messages and email in one place — reply, assign and close.</span>
            </>
          ) : (
            'Website chat, order messages and email in one place — reply, assign and close.'
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {!firstRun && (
          <Link to="/inbox/saved-replies" className={buttonVariants({ variant: 'secondary' })}>
            <MessageSquareText aria-hidden className="size-4" /> Saved replies
          </Link>
        )}
        <Button onClick={() => setChannelsOpen(true)}>Connect a channel</Button>
      </div>
    </div>
  );

  return (
    <>
      {header}
      {firstRun ? (
        <FirstRun readOnly={readOnly} canEdit={canEditChannels(activeTenant)} onOpenChannels={() => setChannelsOpen(true)} />
      ) : (
        <section
          aria-label="Conversations"
          className="flex h-[calc(100dvh-11rem)] min-h-[480px] overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1 lg:h-[calc(100dvh-13rem)] lg:min-h-[560px]"
        >
          {/* List */}
          <div className={cn('flex w-full min-w-0 flex-col border-border-default lg:w-[320px] lg:shrink-0 lg:border-r', hasThread && 'hidden lg:flex')}>
            <ListHeader state={state} counts={counts} onChange={update} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list.isPending ? (
                <ListSkeleton />
              ) : list.isError && !page ? (
                <ListError onRetry={() => void list.refetch()} />
              ) : rows.length === 0 ? (
                <ListEmpty
                  state={state}
                  pending={counts?.pending ?? summary.data?.pending ?? 0}
                  onViewPending={() => update({ status: 'pending', conversation: null })}
                  onClear={() => update({ q: '', channel: null })}
                />
              ) : (
                <>
                  <ul aria-label="Conversation list" className="flex flex-col">
                    {rows.map((c) => (
                      <ConversationRow key={c.id} c={c} selected={c.id === state.conversation} onSelect={() => select(c.id)} />
                    ))}
                  </ul>
                  {nextCursor && (
                    <div className="flex justify-center p-3">
                      <Button size="sm" variant="ghost" loading={more.loading} onClick={() => void loadMore()}>
                        Load more
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Thread */}
          <div className={cn('min-w-0 flex-1 flex-col bg-surface-canvas', hasThread ? 'flex' : 'hidden lg:flex')}>
            {state.conversation ? (
              <ThreadPane
                key={state.conversation}
                conversationId={state.conversation}
                you={user?.id ?? null}
                readOnly={readOnly}
                onBack={() => update({ conversation: null })}
                onOpenCustomer={() => setCustomerOpen(true)}
                onClosed={onClosed}
                onDeleted={() => update({ conversation: null })}
              />
            ) : (
              <NoThread tip={list.isError && !page ? 'Messages open here once the list loads.' : 'Tip: type / in the reply box to insert a saved reply.'} />
            )}
          </div>

          {/* Side panel (xl) */}
          {selected.data && (
            <aside aria-label="Customer" className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-border-default xl:block">
              <CustomerPanel conversation={selected.data} readOnly={readOnly} linking={linkOrder.isPending} onLinkOrder={(id) => linkOrder.mutate({ order_id: id }, { onError: (e) => toast(inboxErrorText(e), 'error') })} />
            </aside>
          )}
        </section>
      )}

      {selected.data && (
        <Drawer open={customerOpen} onClose={() => setCustomerOpen(false)} title="Customer" width={400}>
          <div>
            <CustomerPanel conversation={selected.data} readOnly={readOnly} linking={linkOrder.isPending} onLinkOrder={(id) => linkOrder.mutate({ order_id: id }, { onError: (e) => toast(inboxErrorText(e), 'error') })} />
          </div>
        </Drawer>
      )}

      <ChannelsDrawer open={channelsOpen} onClose={() => setChannelsOpen(false)} readOnly={readOnly} />

      {closed && (
        <div role="status" className="fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 lg:bottom-6">
          <div className="flex max-w-md items-center gap-3 rounded-lg bg-text-primary px-4 py-3 text-body text-text-inverse shadow-elevation-1">
            <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success-bg" />
            <span className="flex-1">Conversation closed. Showing the next open chat in 5 s.</span>
            {!readOnly && (
              <button type="button" onClick={onUndo} className="rounded-md bg-surface-card px-2.5 py-1 text-caption font-semibold text-text-primary">
                Undo
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default InboxPage;
