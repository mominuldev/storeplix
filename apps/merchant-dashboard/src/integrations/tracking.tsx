import type { TrackingChannel, TrackingEventFilters, TrackingEventLogEntry, TrackingEventName, TrackingEventStats, TrackingEventStatus, TrackingProvider } from '@storeplix/types';
import { Badge, Button, cn, formatCount, SegmentedControl, Select } from '@storeplix/ui';
import { Fragment, useState } from 'react';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { KeyValue } from '../sms/components';
import { Panel, TableCard, TableHead, tdClass } from './components';
import { deliveryRate, eventErrorText, eventStatusMeta, eventWhen, providerEventName, providerEvents, sentFrom, timeOfDay } from './integrations';
import { useTrackingEvents, useTrackingStats } from './queries';

// PHASE-8-9D §5.6–§5.7 shared tracking views: per-event stats (Figma "Ecommerce events · last 7 days"), the event log
// (2139:56806: chips, event filter, period, danger-tinted error rows with a detail line, cursor paging) and totals.

const count = (n: number) => formatCount(n);

/** Stats table: one row per event the provider receives, browser vs server counts and a status pill. */
export function EventStatsTable({ provider, stats, mirror, title, action }: { provider: TrackingProvider; stats: TrackingEventStats | undefined; mirror: boolean; title: string; action?: React.ReactNode }) {
  const rows = providerEvents(provider);
  const byEvent = new Map(stats?.rows.map((r) => [r.event, r]));
  return (
    <TableCard title={title} action={action}>
      <table className="w-full min-w-[620px]">
        <TableHead cols={[{ label: 'Event' }, { label: 'When it fires' }, { label: 'Browser' }, { label: 'Server' }, { label: 'Status' }]} />
        <tbody>
          {rows.map((e) => {
            const r = byEvent.get(e);
            const serverOnly = sentFrom(provider, e, mirror) === 'Server';
            const browserOnly = sentFrom(provider, e, mirror) === 'Browser';
            const active = !!r && (r.browser > 0 || r.server_sent > 0);
            return (
              <tr key={e}>
                <td className={cn(tdClass, 'font-medium text-text-primary')}>{providerEventName(provider, e)}</td>
                <td className={tdClass}>{eventWhen[e]}</td>
                <td className={tdClass}>{serverOnly ? '—' : count(r?.browser ?? 0)}</td>
                <td className={tdClass}>{browserOnly ? '—' : count(r?.server_sent ?? 0)}</td>
                <td className={tdClass}>
                  {serverOnly ? (
                    <Badge tone="info" size="sm">
                      Server only
                    </Badge>
                  ) : active ? (
                    <Badge tone="success" size="sm">
                      Active
                    </Badge>
                  ) : (
                    <Badge size="sm">No events yet</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableCard>
  );
}

/** "Last 30 days" / "Last 7 days" totals card. */
export function TotalsCard({ provider, days }: { provider: TrackingProvider; days: 7 | 30 }) {
  const stats = useTrackingStats(provider, days);
  const purchase = stats.data?.rows.find((r) => r.event === 'purchase');
  return (
    <Panel title={days === 30 ? 'Last 30 days' : 'Last 7 days'}>
      {stats.isPending ? (
        <LoadingRows rows={3} label="Loading totals" />
      ) : stats.isError ? (
        <ErrorBlock title="We couldn’t load the totals" error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="flex flex-col gap-3">
          <KeyValue label={`${providerEventName(provider, 'purchase') ?? 'Purchase'} sent`} value={count(purchase?.server_sent ?? 0)} />
          <KeyValue label="Browser events" value={count(stats.data.totals.browser)} />
          <KeyValue label="Server events sent" value={count(stats.data.totals.server_sent)} />
          <KeyValue label="Delivered" value={deliveryRate(stats.data.totals.delivery_rate)} />
          <KeyValue label="Errors" value={count(stats.data.totals.server_failed)} valueClassName={stats.data.totals.server_failed > 0 ? 'text-danger' : undefined} />
        </div>
      )}
    </Panel>
  );
}

/** Stats with a 7 / 30 day switch (Events tab right column). */
export function StatsCard({ provider }: { provider: TrackingProvider }) {
  const [days, setDays] = useState<7 | 30>(7);
  const stats = useTrackingStats(provider, days);
  return (
    <Panel
      title="Event counts"
      actions={
        <SegmentedControl
          aria-label="Period"
          size="sm"
          value={String(days)}
          onChange={(v) => setDays(v === '30' ? 30 : 7)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
          ]}
        />
      }
    >
      {stats.isPending ? (
        <LoadingRows rows={4} label="Loading event counts" />
      ) : stats.isError ? (
        <ErrorBlock title="We couldn’t load the counts" error={stats.error} onRetry={() => void stats.refetch()} />
      ) : stats.data.rows.length === 0 ? (
        <p className="text-body text-text-secondary">No events in the last {days} days.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={`Event counts, last ${days} days`}>
          {stats.data.rows.map((r) => (
            <li key={r.event} className="flex items-center gap-2 text-body">
              <span className="min-w-0 flex-1 text-text-secondary">{r.provider_event_name ?? r.event}</span>
              <span className="font-medium text-text-primary">{count(r.browser + r.server_sent)}</span>
              {r.server_failed > 0 && <span className="text-caption text-danger">{count(r.server_failed)} failed</span>}
            </li>
          ))}
          <li className="border-t border-border-default pt-3">
            <KeyValue label="Delivered" value={deliveryRate(stats.data.totals.delivery_rate)} />
          </li>
        </ul>
      )}
    </Panel>
  );
}

type LogChip = 'all' | 'server' | 'browser' | 'errors';
const CHIP_LABELS: Record<LogChip, string> = { all: 'All', server: 'Server', browser: 'Browser', errors: 'Errors' };
const DAY = 86_400_000;
const sinceFor = (days: number) => new Date(Math.floor((Date.now() - days * DAY) / 60_000) * 60_000).toISOString();

function chipFilters(chip: LogChip): { channel?: TrackingChannel; status?: TrackingEventStatus[] } {
  if (chip === 'server') return { channel: 'server' };
  if (chip === 'browser') return { channel: 'browser' };
  if (chip === 'errors') return { status: ['failed', 'retrying'] };
  return {};
}

function rowPageOrOrder(e: TrackingEventLogEntry): string {
  if (e.order) return `Order ${e.order.number}`;
  return e.page_path ?? '—';
}

/** Event log (§5.6). `test` limits to test-mode rows; `poll` refreshes every 5 s (test mode on). */
export function EventLog({ provider, title, description, test, poll = false, compact = false }: { provider: TrackingProvider; title: string; description?: string; test?: boolean; poll?: boolean; compact?: boolean }) {
  const [chip, setChip] = useState<LogChip>('all');
  const [event, setEvent] = useState<TrackingEventName | ''>('');
  const [period, setPeriodState] = useState<1 | 7>(1);
  // "since" is fixed when the period is picked so the query key stays stable between renders.
  const [since, setSince] = useState(() => sinceFor(1));
  const setPeriod = (p: 1 | 7) => {
    setPeriodState(p);
    setSince(sinceFor(p));
  };
  const [cursors, setCursors] = useState<string[]>([]);
  const filters: TrackingEventFilters = { ...chipFilters(chip), ...(event ? { event: [event] } : {}), ...(test !== undefined ? { test } : {}), since, cursor: cursors[cursors.length - 1] };
  const log = useTrackingEvents(provider, filters, { poll });
  const reset = () => setCursors([]);
  const rows = log.data?.data ?? [];
  const next = log.data?.meta.next_cursor ?? null;

  return (
    <TableCard
      title={title}
      description={description}
      action={
        poll ? (
          <span className="flex items-center gap-1.5 text-body font-medium text-brand-600">
            <span aria-hidden className="size-2 rounded-full bg-brand-600" />
            Live
          </span>
        ) : undefined
      }
    >
      {!compact && (
        <div className="flex flex-col gap-3 px-4 pb-3 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              aria-label="Event"
              value={event}
              onChange={(e) => {
                setEvent(e.target.value as TrackingEventName | '');
                reset();
              }}
              containerClassName="sm:w-48"
            >
              <option value="">Event: All</option>
              {providerEvents(provider).map((e) => (
                <option key={e} value={e}>
                  {providerEventName(provider, e)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Period"
              value={String(period)}
              onChange={(e) => {
                setPeriod(e.target.value === '7' ? 7 : 1);
                reset();
              }}
              containerClassName="sm:w-48"
            >
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
            </Select>
          </div>
          <div role="group" aria-label="Show" className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {(Object.keys(CHIP_LABELS) as LogChip[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={chip === c}
                onClick={() => {
                  setChip(c);
                  reset();
                }}
                className={cn(
                  'shrink-0 rounded-full px-3.5 py-1.5 text-body font-medium whitespace-nowrap outline-none focus-visible:shadow-focus',
                  chip === c ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'bg-surface-card text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)] hover:bg-surface-subtle',
                )}
              >
                {CHIP_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      )}
      {log.isPending ? (
        <div className="px-6 pb-4">
          <LoadingRows rows={5} label="Loading events" />
        </div>
      ) : log.isError ? (
        <ErrorBlock title="We couldn’t load the events" error={log.error} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
          <p className="text-body-lg font-medium text-text-primary">{test ? 'No test events yet' : 'No events yet'}</p>
          <p className="max-w-sm text-body text-text-secondary">
            {test ? 'Open your shop in test mode or send a test event — they show up here within seconds.' : chip !== 'all' || event ? 'Nothing matches these filters.' : 'Events show up here as soon as shoppers visit your shop.'}
          </p>
        </div>
      ) : (
        <>
          <table className="w-full min-w-[680px]">
            <TableHead cols={[{ label: 'Time' }, { label: 'Event' }, { label: 'Page or order' }, { label: 'From' }, { label: 'Event ID' }, { label: 'Status' }]} />
            <tbody>
              {rows.map((e) => {
                const status = eventStatusMeta(e);
                const err = eventErrorText(e);
                const bad = e.status === 'failed';
                return (
                  <Fragment key={e.id}>
                    <tr className={cn(bad && 'bg-danger-bg')}>
                      <td className={cn(tdClass, 'font-medium whitespace-nowrap text-text-primary', bad && err && 'border-b-0')}>{timeOfDay(e.created_at)}</td>
                      <td className={cn(tdClass, 'text-text-primary')}>{e.provider_event_name ?? e.event}</td>
                      <td className={cn(tdClass, 'max-w-[200px] truncate')}>{rowPageOrOrder(e)}</td>
                      <td className={tdClass}>{e.channel === 'server' ? 'Server' : 'Browser'}</td>
                      <td className={cn(tdClass, 'max-w-[160px] truncate font-mono text-caption')}>{e.event_id}</td>
                      <td className={tdClass}>
                        <Badge tone={status.tone} size="sm">
                          {status.label}
                        </Badge>
                      </td>
                    </tr>
                    {err && (
                      <tr className={cn(bad && 'bg-danger-bg')}>
                        <td colSpan={6} className={cn('px-6 pb-2.5 text-caption', bad ? 'text-danger' : 'text-text-secondary')}>
                          {err}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!compact && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border-default px-4 py-3 sm:px-6">
              <p className="min-w-0 flex-1 text-caption text-text-secondary">Delivered and skipped events are kept 7 days, failed ones 30 days.</p>
              <Button size="sm" variant="secondary" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
                Previous
              </Button>
              <Button size="sm" variant="secondary" disabled={!next} onClick={() => next && setCursors((c) => [...c, next])}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </TableCard>
  );
}
