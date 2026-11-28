import type { AdminAiCredits, AdminTenant, AiCreditLedgerEntry } from '@storeplix/types';
import { Button, Card, DataTable, ProgressBar, Skeleton, cn, formatCount, type DataTableColumn } from '@storeplix/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { formatDate, formatDateTime, planName } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { AdjustAiCreditsDialog } from './AdjustAiCreditsDialog';
import { aiLedgerTypeLabel, aiSourceLabel, fmt, ledgerDetail, signed } from './format';
import { aiKeys, useAdminAiCredits } from './queries';

/** Opens the adjust dialog and refreshes the card + ledger after a change (`manage_billing` callers only). */
function useAdjust(tenant: AdminTenant) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const render = (credits: AdminAiCredits | undefined) =>
    open && credits ? (
      <AdjustAiCreditsDialog
        tenantId={tenant.id}
        shopLabel={`${tenant.name} · ${planName(tenant.plan_code)} plan`}
        credits={credits}
        onClose={() => setOpen(false)}
        onDone={(updated, delta) => {
          setOpen(false);
          queryClient.setQueryData(aiKeys.credits(tenant.id), updated);
          void queryClient.invalidateQueries({ queryKey: aiKeys.credits(tenant.id) });
          void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenant.id, 'audit'] });
          toast(`${delta > 0 ? 'Granted' : 'Deducted'} ${fmt(Math.abs(delta))} AI credits · bonus ${fmt(updated.credits.bonus)}`);
        }}
      />
    ) : null;
  return { open: () => setOpen(true), render };
}

/**
 * Merchant detail Overview → "Usage vs plan limits" row "AI credits" (composed on the SMS credits row 33:5121): plan
 * allowance used / limit this month and the sub-line "n% of plan allowance used · n bonus credits · resets {date}",
 * ghost "Adjust AI credits" for `manage_billing`.
 */
export function AiUsageRow({ tenant }: { tenant: AdminTenant }) {
  const can = useCan();
  const credits = useAdminAiCredits(tenant.id);
  const adjust = useAdjust(tenant);
  const a = credits.data?.credits.allowance;
  const pct = a?.limit ? Math.min(100, Math.round((a.used / a.limit) * 100)) : null;
  const warn = pct !== null && pct >= 80;
  const bonus = credits.data?.credits.bonus;
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex items-center gap-3 text-body">
        <span className="min-w-0 flex-1 text-text-primary">AI credits</span>
        <span className="font-medium text-text-primary tabular-nums">
          {a ? `${formatCount(a.used)} / ${a.limit === null ? 'Unlimited' : formatCount(a.limit)}` : '—'}
        </span>
        {can('manage_billing') && (
          <Button variant="ghost" size="sm" onClick={adjust.open} disabled={!credits.data}>
            Adjust AI credits
          </Button>
        )}
      </span>
      <ProgressBar value={pct === null ? 0 : pct / 100} label="AI plan allowance" className={warn ? '[&>*]:bg-warning' : undefined} />
      <span className={cn('text-caption', warn ? 'text-warning' : 'text-text-muted')}>
        {credits.isPending
          ? 'Loading AI credits…'
          : credits.isError
          ? 'AI credits unavailable'
          : [
              pct !== null ? `${pct}% of plan allowance used` : a?.limit === null ? 'Unlimited plan allowance' : 'No AI allowance on this plan',
              bonus !== undefined ? `${fmt(bonus)} bonus credit${bonus === 1 ? '' : 's'}` : null,
              a ? `resets ${formatDate(a.resets_at)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
      </span>
      {adjust.render(credits.data)}
    </li>
  );
}

/**
 * Merchant detail → Billing tab "AI credits" card (PHASE-8-9D §10.4, `view_merchants`; no Figma frame — composed on
 * the 8.9a SMS credits card): available now, plan allowance this month (used / limit, resets), bonus credits, last
 * adjusted; raw ledger (newest first, 50 per page, Load more). "Adjust AI credits" for `manage_billing`.
 */
export function AiCreditsCard({ tenant }: { tenant: AdminTenant }) {
  const can = useCan();
  const credits = useAdminAiCredits(tenant.id);
  const adjust = useAdjust(tenant);
  const ledger = useInfiniteQuery({
    queryKey: aiKeys.ledger(tenant.id),
    queryFn: ({ pageParam }) => api.admin.aiCredits.ledger(tenant.id, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
  });
  const rows = ledger.data?.pages.flatMap((p) => p.data) ?? [];
  const c = credits.data;
  const a = c?.credits.allowance;

  const columns: DataTableColumn<AiCreditLedgerEntry>[] = [
    { key: 'type', header: 'Type', width: 150, cell: (e) => <span className="text-body text-text-primary">{aiLedgerTypeLabel[e.type]}</span> },
    {
      key: 'source',
      header: 'From',
      width: 130,
      cell: (e) => <span className="text-body text-text-secondary">{e.source ? aiSourceLabel[e.source] : 'Bonus'}</span>,
    },
    {
      key: 'credits',
      header: 'Credits',
      width: 100,
      align: 'end',
      cell: (e) => <span className={cn('text-body font-semibold tabular-nums', e.credits > 0 ? 'text-success' : 'text-text-primary')}>{signed(e.credits)}</span>,
    },
    { key: 'after', header: 'Bonus after', width: 120, align: 'end', cell: (e) => <span className="text-body text-text-secondary tabular-nums">{fmt(e.bonus_after)}</span> },
    { key: 'detail', header: 'Tool / reason', cell: (e) => <span className="block truncate text-body text-text-secondary">{ledgerDetail(e)}</span> },
    { key: 'date', header: 'Date', width: 190, cell: (e) => <span className="text-body text-text-secondary">{formatDateTime(e.created_at)}</span> },
  ];

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 px-5 pt-5 pb-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-body-lg font-semibold text-text-primary">AI credits</h2>
          <p className="text-caption text-text-muted">Shared by every AI tool. The monthly plan allowance is used first, then bonus credits (never expire).</p>
        </div>
        {can('manage_billing') && (
          <Button variant="secondary" onClick={adjust.open} disabled={!c}>
            Adjust AI credits
          </Button>
        )}
      </div>
      {credits.isError ? (
        <ErrorState error={credits.error} onRetry={() => void credits.refetch()} title="We couldn’t load AI credits" />
      ) : (
        <dl className="grid gap-4 border-t border-border-default px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Available now" value={c ? fmt(c.credits.available) : null} />
          <Stat
            label="Plan allowance this month"
            value={a ? `${fmt(a.used)} / ${a.limit === null ? 'Unlimited' : fmt(a.limit)}` : null}
            hint={a ? `${a.remaining === null ? 'Unlimited' : fmt(a.remaining)} left · resets ${formatDate(a.resets_at)}` : undefined}
          />
          <Stat label="Bonus credits" value={c ? fmt(c.credits.bonus) : null} />
          <Stat label="Last adjusted" value={c ? (c.last_adjusted_at ? formatDate(c.last_adjusted_at) : 'Never') : null} />
        </dl>
      )}
      <DataTable
        label="AI credit ledger"
        columns={columns}
        rows={rows}
        getRowId={(e) => e.id}
        className="rounded-none border-x-0 border-b-0 shadow-none"
        state={
          ledger.isPending ? (
            <LoadingRows label="Loading AI credit history" rows={3} />
          ) : ledger.isError ? (
            <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
          ) : rows.length === 0 ? (
            <Empty icon={<Sparkles />} title="No AI credit history yet" description="AI tool charges, refunds for failed or undone results and staff adjustments appear here." />
          ) : undefined
        }
        footer={
          ledger.hasNextPage ? (
            <div className="flex justify-center border-t border-border-default px-4 py-3">
              <Button variant="secondary" size="sm" loading={ledger.isFetchingNextPage} onClick={() => void ledger.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : undefined
        }
      />
      {adjust.render(c)}
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="flex flex-col gap-0.5">
        <span className="text-heading text-text-primary tabular-nums">{value ?? <Skeleton className="h-7 w-20" />}</span>
        {hint && <span className="text-caption text-text-muted">{hint}</span>}
      </dd>
    </div>
  );
}
