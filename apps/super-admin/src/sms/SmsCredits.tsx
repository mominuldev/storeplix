import type { AdminSmsCredits, AdminTenant, SmsCreditLedgerEntry } from '@storeplix/types';
import { Badge, Button, Card, DataTable, ProgressBar, Skeleton, cn, formatCount, type DataTableColumn } from '@storeplix/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { formatDate, formatDateTime, planName } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { AdjustSmsCreditsDialog } from './AdjustSmsCreditsDialog';
import { creditStatusMeta, ledgerTypeLabel, signed } from './format';
import { smsKeys, useAdminSmsCredits } from './queries';

const fmt = (n: number) => n.toLocaleString('en-IN');

/** Opens the adjust dialog and refreshes the card + ledger after a change (`manage_billing` callers only). */
function useAdjust(tenant: AdminTenant) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const render = (credits: AdminSmsCredits | undefined) =>
    open && credits ? (
      <AdjustSmsCreditsDialog
        tenantId={tenant.id}
        shopLabel={`${tenant.name} · ${planName(tenant.plan_code)} plan`}
        credits={credits}
        onClose={() => setOpen(false)}
        onDone={(updated, delta) => {
          setOpen(false);
          queryClient.setQueryData(smsKeys.credits(tenant.id), updated);
          void queryClient.invalidateQueries({ queryKey: smsKeys.credits(tenant.id) });
          void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenant.id, 'audit'] });
          toast(`${delta > 0 ? 'Granted' : 'Deducted'} ${fmt(Math.abs(delta))} SMS credits · balance ${fmt(updated.balance)}`);
        }}
      />
    ) : null;
  return { open: () => setOpen(true), render };
}

/**
 * Merchant detail 33:4851 → Usage card row "SMS credits" 33:5121 with the ghost "Adjust credits" 2095:9090: plan
 * allowance used / limit (from `tenant.usage.sms_per_month`, when the plan has one) and the sub-line
 * "n% of plan allowance used · n purchased credits".
 */
export function SmsUsageRow({ tenant }: { tenant: AdminTenant }) {
  const can = useCan();
  const credits = useAdminSmsCredits(tenant.id);
  const adjust = useAdjust(tenant);
  const allowance = tenant.usage.find((u) => u.key === 'sms_per_month');
  const pct = allowance?.limit ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : null;
  const warn = pct !== null && pct >= 80;
  const purchased = credits.data
    ? `${fmt(credits.data.balance)} purchased credit${credits.data.balance === 1 ? '' : 's'}`
    : credits.isError
    ? 'purchased credits unavailable'
    : null;
  return (
    <li className="flex flex-col gap-1.5">
      <span className="flex items-center gap-3 text-body">
        <span className="min-w-0 flex-1 text-text-primary">SMS credits</span>
        <span className="font-medium text-text-primary tabular-nums">
          {allowance ? `${formatCount(allowance.used)} / ${allowance.limit === null ? 'Unlimited' : formatCount(allowance.limit)}` : credits.data ? fmt(credits.data.balance) : '—'}
        </span>
        {can('manage_billing') && (
          <Button variant="ghost" size="sm" onClick={adjust.open} disabled={!credits.data}>
            Adjust credits
          </Button>
        )}
      </span>
      <ProgressBar value={pct === null ? 0 : pct / 100} label="SMS plan allowance" className={warn ? '[&>*]:bg-warning' : undefined} />
      <span className={cn('text-caption', warn ? 'text-warning' : 'text-text-muted')}>
        {[
          pct !== null ? `${pct}% of plan allowance used` : allowance?.limit === null ? 'Unlimited plan allowance' : 'No SMS allowance on this plan',
          credits.isPending ? 'loading purchased credits…' : purchased,
          warn && credits.data && credits.data.status !== 'healthy' ? 'top-up suggested' : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {adjust.render(credits.data)}
    </li>
  );
}

/**
 * Merchant detail → Billing tab "SMS credits" card (§13.2, `view_merchants`): balance + status pill, used this month,
 * purchased total, last purchase, low-credit threshold; raw ledger (newest first, 50 per page, Load more).
 * "Adjust credits" for `manage_billing`.
 */
export function SmsCreditsCard({ tenant }: { tenant: AdminTenant }) {
  const can = useCan();
  const credits = useAdminSmsCredits(tenant.id);
  const adjust = useAdjust(tenant);
  const ledger = useInfiniteQuery({
    queryKey: smsKeys.ledger(tenant.id),
    queryFn: ({ pageParam }) => api.admin.smsCredits.ledger(tenant.id, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.next_cursor ?? undefined,
  });
  const rows = ledger.data?.pages.flatMap((p) => p.data) ?? [];
  const c = credits.data;

  const columns: DataTableColumn<SmsCreditLedgerEntry>[] = [
    { key: 'type', header: 'Type', width: 150, cell: (e) => <span className="text-body text-text-primary">{ledgerTypeLabel[e.type]}</span> },
    {
      key: 'credits',
      header: 'Credits',
      width: 110,
      align: 'end',
      cell: (e) => <span className={cn('text-body font-semibold tabular-nums', e.credits > 0 ? 'text-success' : 'text-text-primary')}>{signed(e.credits)}</span>,
    },
    { key: 'after', header: 'Balance after', width: 130, align: 'end', cell: (e) => <span className="text-body text-text-secondary tabular-nums">{fmt(e.balance_after)}</span> },
    {
      key: 'detail',
      header: 'Invoice / reason',
      cell: (e) => <span className="block truncate text-body text-text-secondary">{e.invoice ? e.invoice.number : e.reason ?? '—'}</span>,
    },
    { key: 'date', header: 'Date', width: 190, cell: (e) => <span className="text-body text-text-secondary">{formatDateTime(e.created_at)}</span> },
  ];

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 px-5 pt-5 pb-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-body-lg font-semibold text-text-primary">SMS credits</h2>
          <p className="text-caption text-text-muted">Purchased credits (1 credit = 1 SMS part, never expire). The plan allowance is used first.</p>
        </div>
        {can('manage_billing') && (
          <Button variant="secondary" onClick={adjust.open} disabled={!c}>
            Adjust credits
          </Button>
        )}
      </div>
      {credits.isError ? (
        <ErrorState error={credits.error} onRetry={() => void credits.refetch()} title="We couldn’t load SMS credits" />
      ) : (
        <dl className="grid gap-4 border-t border-border-default px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat
            label="Balance"
            value={
              c ? (
                <span className="flex items-center gap-2">
                  {fmt(c.balance)}
                  <Badge size="sm" tone={creditStatusMeta[c.status].tone}>
                    {creditStatusMeta[c.status].label}
                  </Badge>
                </span>
              ) : null
            }
          />
          <Stat label="Used this month" value={c ? fmt(c.used_this_month) : null} />
          <Stat label="Purchased total" value={c ? fmt(c.purchased_total) : null} />
          <Stat label="Last purchase" value={c ? (c.last_purchase_at ? formatDate(c.last_purchase_at) : 'Never') : null} />
          <Stat label="Low-credit alert" value={c ? (c.low_credit_threshold === null ? 'Off' : `Below ${fmt(c.low_credit_threshold)}`) : null} />
        </dl>
      )}
      <DataTable
        label="SMS credit ledger"
        columns={columns}
        rows={rows}
        getRowId={(e) => e.id}
        className="rounded-none border-x-0 border-b-0 shadow-none"
        state={
          ledger.isPending ? (
            <LoadingRows label="Loading credit history" rows={3} />
          ) : ledger.isError ? (
            <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />
          ) : rows.length === 0 ? (
            <Empty icon={<MessageCircle />} title="No credit history yet" description="Purchases, SMS charged to credits and staff adjustments appear here." />
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

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-heading text-text-primary tabular-nums">{value ?? <Skeleton className="h-7 w-20" />}</dd>
    </div>
  );
}
