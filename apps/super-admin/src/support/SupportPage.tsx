import {
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_CATEGORY_LABELS,
  type AdminSupportFilters,
  type AdminSupportTicketSummary,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from '@storeplix/types';
import { Badge, Card, Menu, Pagination, SegmentedControl, Tabs, cn } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, Clock, Inbox, LifeBuoy, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { planName } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useDebounced } from '../lib/useDebounced';
import { duration, PRIORITIES, PRIORITY_LABELS, priorityTone, since, waiting } from './format';
import { QUEUE_POLL_MS, supportKeys } from './queries';
import { TicketDetail } from './TicketDetail';

type Tab = 'waiting_us' | 'awaiting_merchant' | 'resolved' | 'closed' | 'all';
const TAB_STATUSES: Record<Tab, SupportTicketStatus[]> = {
  waiting_us: ['open', 'awaiting_support'],
  awaiting_merchant: ['awaiting_merchant'],
  resolved: ['resolved'],
  closed: ['closed'],
  all: ['open', 'awaiting_support', 'awaiting_merchant', 'resolved', 'closed'],
};
const TABS = Object.keys(TAB_STATUSES) as Tab[];
type Assignee = 'all' | 'me' | 'unassigned';
type Sort = NonNullable<AdminSupportFilters['sort']>;
const SORT_LABEL: Record<Sort, string> = { waiting: 'Longest waiting', newest: 'Newest', updated: 'Recently updated', priority: 'Priority' };

function QueueRow({ t, active, search }: { t: AdminSupportTicketSummary; active: boolean; search: string }) {
  const w = t.status === 'open' || t.status === 'awaiting_support' ? waiting(t.waiting_since) : null;
  return (
    <li>
      <Link
        to={`/support/${t.id}${search}`}
        aria-current={active ? 'true' : undefined}
        className={cn('flex flex-col gap-1 border-b border-border-default px-4 py-3 outline-none hover:bg-surface-subtle focus-visible:shadow-focus', active && 'bg-brand-50 hover:bg-brand-50')}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-text-primary">{t.shop.store_name ?? t.shop.tenant_name}</span>
          <span className="shrink-0 text-caption text-text-muted">{since(t.last_message_at)}</span>
        </span>
        <span className="truncate text-body text-text-secondary">{t.subject}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-caption text-text-muted">
            {planName(t.shop.plan)} · {t.reference}
            {t.assignee ? ` · ${t.assignee.name.split(' ')[0]}` : ' · Unassigned'}
          </span>
          {t.priority !== 'normal' && (
            <Badge size="sm" tone={priorityTone[t.priority]}>
              {PRIORITY_LABELS[t.priority]}
            </Badge>
          )}
          {w && (
            <Badge size="sm" tone={w.tone}>
              <Clock aria-hidden className="size-3" />
              {w.label}
            </Badge>
          )}
        </span>
      </Link>
    </li>
  );
}

function FilterChip({ label, value, entries }: { label: string; value: string; entries: { key: string; label: string; onSelect: () => void }[] }) {
  return (
    <Menu
      label={label}
      align="start"
      triggerClassName="flex size-auto h-8 items-center whitespace-nowrap gap-1 rounded-full border border-border-default bg-surface-card px-3 text-caption font-medium text-text-secondary outline-none hover:text-text-primary focus-visible:shadow-focus"
      trigger={
        <>
          {value}
          <ChevronDown aria-hidden className="size-3.5" />
        </>
      }
      entries={entries}
    />
  );
}

// Platform / Support tickets 39:15432 (PHASE-8-9C §9/§14, `manage_support`): queue (status tabs, assignee Me /
// Unassigned / anyone, priority, category, search, sort; waiting time amber > 24 h, red > 72 h — display only), thread
// and merchant context panel. Macros and "New ticket" are hidden (Q329). Queue polls every 60 s, thread every 15 s.
export function SupportPage() {
  const can = useCan();
  const allowed = can('manage_support');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t === params.get('tab')) ?? 'waiting_us';
  const assignee = (['me', 'unassigned'] as const).find((a) => a === params.get('assignee')) ?? 'all';
  const priority = PRIORITIES.find((p) => p === params.get('priority'));
  const category = SUPPORT_TICKET_CATEGORIES.find((c) => c === params.get('category'));
  const sort = (Object.keys(SORT_LABEL) as Sort[]).find((s) => s === params.get('sort')) ?? 'waiting';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 300);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const value = debouncedQ.length >= 2 ? debouncedQ : '';
    if ((params.get('q') ?? '') !== value) update({ q: value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filters: AdminSupportFilters = {
    status: TAB_STATUSES[tab],
    assignee: assignee === 'all' ? undefined : assignee,
    priority: priority ? [priority] : undefined,
    category: category ? [category] : undefined,
    q: params.get('q') ?? undefined,
    sort,
    page,
    per_page: 25,
  };
  const list = useQuery({
    queryKey: [...supportKeys.list, filters],
    queryFn: () => api.admin.support.list(filters),
    placeholderData: keepPreviousData,
    enabled: allowed,
    refetchInterval: QUEUE_POLL_MS,
  });

  if (!allowed) {
    return (
      <>
        <PageHeader title="Support tickets" />
        <Card>
          <Empty icon={<LifeBuoy />} title="You don’t have access to support tickets" description="Ask a super admin for the “Support tickets” permission (support, billing and super admins have it)." />
        </Card>
      </>
    );
  }

  const meta = list.data?.meta;
  const counts = meta?.counts;
  const tabCount = (t: Tab): number | null => {
    if (!counts) return null;
    if (t === 'all') return null;
    return TAB_STATUSES[t].reduce((n, s) => n + counts[s], 0);
  };
  const stats = meta?.stats;
  const subtitle = counts
    ? [
        `${counts.open + counts.awaiting_support} waiting on us`,
        `${counts.unassigned} unassigned`,
        stats?.median_first_reply_seconds_7d != null ? `median first reply ${duration(stats.median_first_reply_seconds_7d)} (7 days)` : null,
        stats?.csat_average_30d != null ? `CSAT ${stats.csat_average_30d.toFixed(1)} / 5 (${stats.csat_count_30d}, 30 days)` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Merchant questions from every shop, longest waiting first.';
  const search = params.toString() ? `?${params.toString()}` : '';
  const filtered = !!(filters.q || priority || category || assignee !== 'all');

  return (
    <>
      <PageHeader
        title="Support tickets"
        subtitle={subtitle}
        actions={
          <SegmentedControl
            aria-label="Assignee"
            size="sm"
            value={assignee}
            onChange={(v: Assignee) => update({ assignee: v === 'all' ? null : v })}
            options={[
              { value: 'me', label: `My queue${counts ? ` (${counts.mine})` : ''}` },
              { value: 'all', label: 'All tickets' },
              { value: 'unassigned', label: `Unassigned${counts ? ` (${counts.unassigned})` : ''}` },
            ]}
          />
        }
      />
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section aria-label="Ticket queue" className={cn('flex min-w-0 flex-col self-start overflow-hidden rounded-card border border-border-default bg-surface-card', id && 'hidden lg:flex')}>
          <div className="flex flex-col gap-3 border-b border-border-default px-4 pt-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col">
                <h2 className="text-body-lg font-semibold text-text-primary">Inbox</h2>
                <span className="text-caption text-text-muted">Sorted by {SORT_LABEL[sort].toLowerCase()}</span>
              </div>
              <FilterChip
                label="Sort"
                value="Sort"
                entries={(Object.keys(SORT_LABEL) as Sort[]).map((s) => ({ key: s, label: SORT_LABEL[s], onSelect: () => update({ sort: s === 'waiting' ? null : s }) }))}
              />
            </div>
            <label className="flex h-10 items-center gap-2 rounded-md border border-border-default px-3 focus-within:border-brand-600 focus-within:shadow-focus">
              <Search aria-hidden className="size-4 text-text-muted" />
              <input
                type="search"
                aria-label="Search ticket, shop or owner email"
                placeholder="Search T-number, shop or owner email"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
              />
            </label>
            <Tabs
              aria-label="Ticket status"
              value={tab}
              onChange={(v) => update({ tab: v === 'waiting_us' ? null : v })}
              className="-mx-0 border-b-0 px-0"
              items={[
                { value: 'waiting_us', label: 'Waiting on us', count: tabCount('waiting_us') },
                { value: 'awaiting_merchant', label: 'On merchant', count: tabCount('awaiting_merchant') },
                { value: 'resolved', label: 'Resolved', count: tabCount('resolved') },
                { value: 'closed', label: 'Closed' },
                { value: 'all', label: 'All' },
              ]}
            />
            <div className="flex flex-wrap gap-2 pb-3">
              <FilterChip
                label="Priority"
                value={priority ? PRIORITY_LABELS[priority] : 'Any priority'}
                entries={[
                  { key: 'any', label: 'Any priority', onSelect: () => update({ priority: null }) },
                  ...PRIORITIES.map((p: SupportTicketPriority) => ({ key: p, label: PRIORITY_LABELS[p], onSelect: () => update({ priority: p }) })),
                ]}
              />
              <FilterChip
                label="Category"
                value={category ? SUPPORT_TICKET_CATEGORY_LABELS[category] : 'Any topic'}
                entries={[
                  { key: 'any', label: 'Any topic', onSelect: () => update({ category: null }) },
                  ...SUPPORT_TICKET_CATEGORIES.map((c: SupportTicketCategory) => ({ key: c, label: SUPPORT_TICKET_CATEGORY_LABELS[c], onSelect: () => update({ category: c }) })),
                ]}
              />
            </div>
          </div>
          {list.isPending ? (
            <LoadingRows label="Loading tickets" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.data.length === 0 ? (
            <Empty
              icon={<Inbox />}
              title={filtered ? 'No tickets match these filters' : tab === 'waiting_us' ? 'Nobody is waiting on us' : 'No tickets here'}
              description={filtered ? 'Try another search, priority or assignee.' : 'New merchant tickets appear here, longest waiting first.'}
            />
          ) : (
            <ul aria-label="Tickets" className="flex flex-col">
              {list.data.data.map((t) => (
                <QueueRow key={t.id} t={t} active={t.id === id} search={search} />
              ))}
            </ul>
          )}
          {meta && meta.total > meta.per_page && (
            <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="tickets" onPage={(p) => update({ page: p > 1 ? String(p) : null })} />
          )}
        </section>
        {id ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Link to={`/support${search}`} className="flex items-center gap-1.5 text-body font-medium text-brand-600 lg:hidden">
              <ArrowLeft aria-hidden className="size-4" />
              Back to queue
            </Link>
            <TicketDetail key={id} ticketId={id} />
          </div>
        ) : (
          <Card className="hidden lg:block">
            <Empty icon={<LifeBuoy />} title="Pick a ticket" description="Open a ticket from the inbox to read the thread and reply." />
          </Card>
        )}
      </div>
    </>
  );
}
