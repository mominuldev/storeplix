import type { SupportTicketSummary, SupportTicketTab } from '@storeplix/types';
import { SUPPORT_TICKET_CATEGORY_LABELS } from '@storeplix/types';
import { Avatar, Button, cn, Pagination, Tabs } from '@storeplix/ui';
import { ChevronRight, Inbox, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { NoAccessState } from '../layout/RequirePermission';
import { PageHeader } from '../layout/PageHeader';
import { PriorityBadge, TicketStatusBadge } from './components';
import { helpErrorText } from './errors';
import { agoLabel, canContactSupport, formatDuration, formatHelpDate, parseTicketTab, TICKET_TAB_LABELS, TICKET_TABS } from './help';
import { useNewTicket } from './NewTicketModal';
import { useTicketList } from './queries';

// PHASE-8-9C §13 My tickets 71:22058 (`/help/tickets`, `support.manage`): stats (Open, Waiting on you, Solved this
// month, Avg. first reply; "Rated x / 5" once ratings exist), tabs with counts, search (subject or T-number), table →
// cards below `lg`, empty / error / loading states (2130:965). No "Reply times" SLA footer (Q329).

export function TicketsPage() {
  const { activeTenant } = useAuth();
  if (!canContactSupport(activeTenant))
    return <NoAccessState heading="Support tickets" title="Ask your shop owner to contact support" description="Only members who can contact Store Plix support see this shop’s tickets." />;
  return <TicketsInner />;
}

function TicketsInner() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const readOnly = useReadOnly();
  const tab = parseTicketTab(params.get('tab'));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const ticket = useNewTicket();

  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() === q.trim()) return;
      const p = new URLSearchParams(params);
      if (text.trim().length >= 2) p.set('q', text.trim());
      else p.delete('q');
      p.delete('page');
      setParams(p, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [text, q, params, setParams]);

  const list = useTicketList({ tab, q: q.trim().length >= 2 ? q.trim() : undefined, page, per_page: 20 });
  const meta = list.data?.meta;
  const stats = meta?.stats;
  const rows = list.data?.data ?? [];

  const setTab = (t: SupportTicketTab) => {
    const p = new URLSearchParams(params);
    if (t === 'all') p.delete('tab');
    else p.set('tab', t);
    p.delete('page');
    setParams(p);
  };

  return (
    <div className="flex flex-col gap-5">
      {ticket.banner}
      <PageHeader
        title="Support tickets"
        subtitle="Questions you’ve sent to the Store Plix team. We reply here and by email."
        actions={
          <>
            <Link to="/help" className="hidden sm:block">
              <Button variant="secondary">Help center</Button>
            </Link>
            <Button onClick={ticket.open} disabled={readOnly}>
              + New ticket
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat dot="bg-info" label="Open" value={stats?.open} hint="We’re working on these" />
        <Stat dot="bg-warning" label="Waiting on you" value={stats?.waiting_on_you} hint="Reply to keep it moving" />
        <Stat
          dot="bg-success"
          label="Solved this month"
          value={stats?.solved_this_month}
          hint={stats && stats.csat_count > 0 && stats.csat_average !== null ? `Rated ${stats.csat_average.toFixed(1)} / 5 by you` : 'Tickets you closed'}
        />
        <Stat dot="bg-brand-600" label="Avg. first reply" value={stats ? formatDuration(stats.avg_first_reply_seconds) : undefined} hint="Last 90 days" />
      </div>

      <section className="flex flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
        <div className="flex flex-col gap-3 px-4 pt-3 lg:flex-row lg:items-center lg:px-5">
          <Tabs
            aria-label="Ticket status"
            value={tab}
            onChange={setTab}
            className="flex-1 lg:border-b-0"
            items={TICKET_TABS.map((t) => ({ value: t, label: TICKET_TAB_LABELS[t], count: meta?.counts[t] ?? null }))}
          />
          <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 lg:w-[260px]">
            <Search aria-hidden className="size-4 text-text-muted" />
            <input
              type="search"
              aria-label="Search tickets"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search tickets or T-1234"
              className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
        </div>

        {list.isPending ? (
          <LoadingRows rows={5} label="Loading tickets" />
        ) : list.isError ? (
          <ErrorBlock title="Couldn’t load your tickets" message={`Your tickets are safe. ${helpErrorText(list.error)}`} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          q || tab !== 'all' ? (
            <NoResults title="No tickets match" description="Try another tab or search." onClear={() => setText('')} />
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-secondary">
                <Inbox aria-hidden className="size-6" />
              </span>
              <h2 className="text-body-lg font-medium text-text-primary">No tickets yet</h2>
              <p className="max-w-sm text-body text-text-secondary">When you contact support, your questions and our replies show up here.</p>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={ticket.open} disabled={readOnly}>
                  New ticket
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void navigate('/help')}>
                  Browse guides
                </Button>
              </div>
            </div>
          )
        ) : (
          <>
            <table className="hidden w-full lg:table">
              <thead>
                <tr className="border-y border-border-default bg-surface-subtle text-left text-caption font-medium tracking-wide text-text-secondary uppercase">
                  <th className="px-5 py-3 font-medium">Ticket</th>
                  <th className="px-3 py-3 font-medium">Related order</th>
                  <th className="px-3 py-3 font-medium">Priority</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Last reply</th>
                  <th className="w-10" aria-label="Open" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => void navigate(`/help/tickets/${t.id}`)} className={cn('cursor-pointer hover:bg-surface-subtle', t.status === 'awaiting_merchant' && 'bg-brand-50/60')}>
                    <td className="px-5 py-3.5">
                      <Link to={`/help/tickets/${t.id}`} className="flex flex-col gap-0.5 outline-none focus-visible:shadow-focus" onClick={(e) => e.stopPropagation()}>
                        <span className="text-body text-text-primary">
                          <span className="mr-2 text-caption text-text-muted">{t.reference}</span>
                          <span className="font-medium">{t.subject}</span>
                        </span>
                        <span className="text-caption text-text-secondary">
                          {SUPPORT_TICKET_CATEGORY_LABELS[t.category]} · opened {formatHelpDate(t.created_at)}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3.5 text-body">{t.related_order ? <span className="text-brand-600">{t.related_order.number}</span> : <span className="text-text-muted">—</span>}</td>
                    <td className="px-3 py-3.5">
                      <PriorityBadge priority={t.priority} />
                    </td>
                    <td className="px-3 py-3.5">
                      <TicketStatusBadge status={t.status} />
                    </td>
                    <td className="px-3 py-3.5">
                      <LastReply t={t} />
                    </td>
                    <td className="pr-5">
                      <ChevronRight aria-hidden className="size-4 text-text-muted" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="flex flex-col divide-y divide-border-default border-t border-border-default lg:hidden">
              {rows.map((t) => (
                <li key={t.id}>
                  <Link to={`/help/tickets/${t.id}`} className={cn('flex flex-col gap-2 px-4 py-3.5', t.status === 'awaiting_merchant' && 'bg-brand-50/60')}>
                    <span className="flex items-start gap-2">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-caption text-text-muted">{t.reference}</span>
                        <span className="text-body font-medium text-text-primary">{t.subject}</span>
                      </span>
                      <TicketStatusBadge status={t.status} size="sm" />
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
                      <PriorityBadge priority={t.priority} />
                      <span>{SUPPORT_TICKET_CATEGORY_LABELS[t.category]}</span>
                      {t.related_order && <span className="text-brand-600">{t.related_order.number}</span>}
                      {t.last_reply && <span className="ml-auto">{agoLabel(t.last_reply.at)}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {meta && meta.last_page > 1 && (
              <Pagination
                page={meta.current_page}
                perPage={meta.per_page}
                total={meta.total}
                lastPage={meta.last_page}
                noun="tickets"
                onPage={(n) => {
                  const p = new URLSearchParams(params);
                  p.set('page', String(n));
                  setParams(p);
                }}
                className="border-t border-border-default"
              />
            )}
          </>
        )}
      </section>
      {ticket.modal}
    </div>
  );
}

function Stat({ dot, label, value, hint }: { dot: string; label: string; value: number | string | undefined; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-card border border-border-default bg-surface-card px-4 py-4 shadow-elevation-1 lg:px-5">
      <span className="flex items-center gap-2 text-body text-text-secondary">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-heading-24 text-text-primary">{value ?? '—'}</span>
      <span className="truncate text-caption text-text-muted">{hint}</span>
    </div>
  );
}

function LastReply({ t }: { t: SupportTicketSummary }) {
  if (!t.last_reply) return <span className="text-caption text-text-muted">—</span>;
  const who = t.last_reply.author.is_staff ? t.last_reply.author.name.split(' · ')[0] : t.last_reply.author.name;
  return (
    <span className="flex items-center gap-2 text-caption text-text-secondary">
      <Avatar name={who} size="sm" />
      {who} · {agoLabel(t.last_reply.at)}
    </span>
  );
}

export default TicketsPage;
