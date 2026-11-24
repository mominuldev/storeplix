import { isApiError } from '@storeplix/api-client';
import type { Campaign, CampaignRecipient, CampaignRecipientStatus } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, DataTable, Dialog, KpiTile, type DataTableColumn } from '@storeplix/ui';
import { AlertTriangle, BarChart3, Send, ShoppingBag, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { Cell2, FilterSelect } from '../catalog/ui';
import { can } from '../lib/permissions';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { storeDomain } from '../stores/useTenantStore';
import { campaignActions, errorCodeLabels, failureLabels, mergeBody, recipientStatusMeta, renderSms, SAMPLE_NAME, skipReasonLabels, whenLabel } from './campaigns';
import { useCampaign, useCampaignCommand, useCampaignRecipients } from './queries';
import { CampaignStatusPill, ChannelTag } from './ui';

// PHASE-8-5 §8.4 Campaign detail, composed: page header (name, status pill, channel tag, actions per state), KPI tiles
// (Recipients, Sent, Orders, Revenue + failed/skipped/unsubscribed caption), read-only message card (rendered sample),
// recipients table (only with `customers.view`; masked addresses). While `sending` the page polls every 5 s.

export function CampaignDetailPage() {
  const { campaignId } = useParams();
  const query = useCampaign(campaignId);
  if (query.isPending) return <LoadingState label="Loading campaign" />;
  if (query.isError)
    return (
      <StateCard>
        <ErrorBlock title={isApiError(query.error) && query.error.status === 404 ? 'Campaign not found' : 'We couldn’t load this campaign'} error={query.error} onRetry={() => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/marketing/campaigns" className="font-semibold text-brand-600">
            Back to campaigns
          </Link>
        </p>
      </StateCard>
    );
  return <CampaignView campaign={query.data} />;
}

function CampaignView({ campaign: c }: { campaign: Campaign }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const command = useCampaignCommand();
  const [cancelling, setCancelling] = useState(false);
  const [now] = useState(() => Date.now());
  const a = campaignActions(c.status);
  const s = c.stats;

  const run = (cmd: 'unschedule' | 'duplicate' | 'cancel') =>
    command.mutate(
      { id: c.id, command: cmd },
      {
        onSuccess: (row) => {
          setCancelling(false);
          if (cmd === 'duplicate') {
            toast(`“${row.name}” created as a draft.`);
            navigate(`/marketing/campaigns/${row.id}/edit`);
          } else toast(cmd === 'unschedule' ? 'Moved back to drafts.' : 'Campaign cancelled.');
        },
        onError: (e) => toast(errorMessage(e), 'error'),
      },
    );

  const when =
    c.status === 'scheduled'
      ? c.scheduled_at && Date.parse(c.scheduled_at) <= now
        ? 'Waiting to start — it begins when a sending slot frees up (up to 3 campaigns send at once, 9 AM–9 PM)'
        : `Scheduled for ${whenLabel(c.scheduled_at, tz)}`
      : c.status === 'draft'
        ? `Draft · created ${whenLabel(c.created_at, tz)}`
        : c.started_at
          ? `Started ${whenLabel(c.started_at, tz)}${c.completed_at ? ` · finished ${whenLabel(c.completed_at, tz)}` : ''}`
          : c.cancelled_at
            ? `Cancelled ${whenLabel(c.cancelled_at, tz)}`
            : `Created ${whenLabel(c.created_at, tz)}`;

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <nav aria-label="Breadcrumb" className="text-caption font-medium text-text-muted">
            <Link to="/marketing" className="hover:text-text-primary">
              Marketing
            </Link>
            {'  /  '}
            <Link to="/marketing/campaigns" className="hover:text-text-primary">
              Campaigns
            </Link>
          </nav>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-heading-24 break-words text-text-primary">{c.name}</h1>
            <CampaignStatusPill status={c.status} />
            <ChannelTag channel={c.channel} />
          </div>
          <p className="text-body text-text-secondary">
            {c.audience_label} · {when}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {a.edit && (
            <Link to={`/marketing/campaigns/${c.id}/edit`} className={buttonVariants({ variant: 'secondary' })}>
              Edit
            </Link>
          )}
          {a.unschedule && (
            <Button variant="secondary" onClick={() => run('unschedule')} loading={command.isPending && command.variables?.command === 'unschedule'}>
              Unschedule
            </Button>
          )}
          <Button variant="secondary" onClick={() => run('duplicate')} loading={command.isPending && command.variables?.command === 'duplicate'}>
            Duplicate
          </Button>
          {a.cancel && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {c.status === 'failed' && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-danger-bg px-3 py-2.5 text-body font-medium text-danger">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          Not sent: {failureLabels[c.failure_reason ?? ''] ?? 'something went wrong'}.
        </p>
      )}
      {c.status === 'sending' && (
        <p role="status" className="flex items-center gap-2 rounded-md bg-warning-bg px-3 py-2.5 text-body font-medium text-warning">
          <Send aria-hidden className="size-4 shrink-0" />
          Sending now — this page updates by itself. Sending pauses between 9 PM and 9 AM shop time.
        </p>
      )}

      <section aria-label="Campaign results" className="flex flex-col gap-2">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiTile icon={<Users />} label="Recipients" value={formatCount(s.recipients)} />
          <KpiTile icon={<Send />} label="Sent" value={formatCount(s.sent)} hint={c.channel === 'sms' && s.parts_sent > 0 ? `${formatCount(s.parts_sent)} SMS parts` : undefined} />
          <KpiTile icon={<ShoppingBag />} label="Orders" value={formatCount(s.orders)} hint="within 7 days of the message" />
          <KpiTile icon={<BarChart3 />} label="Revenue" value={formatBdt(s.revenue_amount)} />
        </div>
        <p className="text-caption text-text-muted" data-testid="stats-caption">
          {formatCount(s.failed)} failed · {formatCount(s.skipped)} skipped · {formatCount(s.unsubscribed)} unsubscribed
        </p>
      </section>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <MessageCard campaign={c} />
        <div className="min-w-0 flex-1">{can.viewCustomers(scope.membership) ? <Recipients campaign={c} tz={tz} /> : <RecipientsHidden />}</div>
      </div>

      <Dialog
        open={cancelling}
        title="Cancel this campaign?"
        description={c.status === 'sending' ? 'Messages already sent stay sent. Nobody else will get it.' : 'It won’t be sent. You can duplicate it later.'}
        confirmLabel="Cancel campaign"
        cancelLabel="Keep it"
        tone="danger"
        loading={command.isPending}
        onConfirm={() => run('cancel')}
        onCancel={() => setCancelling(false)}
      />
    </>
  );
}

function MessageCard({ campaign: c }: { campaign: Campaign }) {
  const scope = useStoreScope();
  const store = scope.store;
  const ctx = {
    channel: c.channel,
    language: c.language,
    shopName: store?.name ?? '',
    host: store ? storeDomain(store) : '',
    couponCode: c.coupon?.code ?? null,
    product: c.product,
    name: SAMPLE_NAME[c.language],
  };
  const bn = c.language === 'bn';
  return (
    <section aria-label="Message" className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6 lg:w-[360px] lg:shrink-0">
      <h2 className="text-body-lg font-medium text-text-primary">Message</h2>
      {c.channel === 'email' && <p className={cn('text-body font-semibold break-words text-text-primary', bn && 'font-bangla')}>{c.subject}</p>}
      <p data-testid="message-sample" className={cn('rounded-lg bg-surface-subtle p-3 whitespace-pre-line break-words text-text-primary', bn ? 'font-bangla text-[15px] leading-6' : 'text-body')}>
        {c.channel === 'sms' ? renderSms(c.body, ctx).text : mergeBody(c.body, ctx)}
      </p>
      <p className="text-caption text-text-muted">Sample with the name “{SAMPLE_NAME[c.language]}”. Every message has its own opt-out link.</p>
    </section>
  );
}

function RecipientsHidden() {
  return (
    <StateCard>
      <NoResults title="Recipient list hidden" description="You need access to customers to see who got this campaign." />
    </StateCard>
  );
}

const STATUS_FILTERS: { value: '' | CampaignRecipientStatus; label: string }[] = [
  { value: '', label: 'Status: Any' },
  { value: 'sent', label: 'Sent' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
  { value: 'queued', label: 'Queued' },
  { value: 'unknown', label: 'Unknown' },
];

function Recipients({ campaign: c, tz }: { campaign: Campaign; tz: string }) {
  const [status, setStatus] = useState<'' | CampaignRecipientStatus>('');
  const notStarted = c.status === 'draft' || c.status === 'scheduled';
  const list = useCampaignRecipients(c.id, { status: status ? [status] : undefined }, { enabled: !notStarted, poll: c.status === 'sending' });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  const columns: DataTableColumn<CampaignRecipient>[] = [
    {
      key: 'customer',
      header: 'Customer',
      mobileLabel: false,
      cell: (r) => (
        <Cell2
          top={r.customer ? <Link to={`/customers/${r.customer.id}`} className="hover:text-brand-600" onClick={(e) => e.stopPropagation()}>{r.customer.name}</Link> : 'Deleted customer'}
          bottom={r.masked_address}
          topClass="font-medium"
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 150,
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <Badge size="sm" tone={recipientStatusMeta[r.status].tone}>
            {recipientStatusMeta[r.status].label}
          </Badge>
          {(r.skip_reason || r.error_code || r.unsubscribed_at) && (
            <span className="text-caption text-text-muted">
              {r.skip_reason ? skipReasonLabels[r.skip_reason] : r.error_code ? (errorCodeLabels[r.error_code] ?? r.error_code) : 'Unsubscribed'}
            </span>
          )}
        </span>
      ),
    },
    { key: 'sent', header: 'Sent at', width: 130, cell: (r) => <span className="text-body text-text-secondary">{r.sent_at ? whenLabel(r.sent_at, tz) : '—'}</span> },
    {
      key: 'order',
      header: 'Order',
      width: 130,
      cell: (r) =>
        r.attributed_order ? (
          <Link to={`/orders/${r.attributed_order.id}`} className="flex flex-col text-body font-medium text-brand-600" onClick={(e) => e.stopPropagation()}>
            #{r.attributed_order.number}
            <span className="text-caption font-normal text-text-muted">{formatBdt(r.attributed_order.total_amount)}</span>
          </Link>
        ) : (
          <span className="text-body text-text-muted">—</span>
        ),
    },
  ];

  return (
    <DataTable
      label="Recipients"
      headTone="canvas"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      toolbar={
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <h2 className="flex-1 text-body-lg font-medium text-text-primary">Recipients</h2>
          {!notStarted && (
            <FilterSelect label="Recipient status" value={status} onChange={(e) => setStatus(e.target.value as '' | CampaignRecipientStatus)}>
              {STATUS_FILTERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FilterSelect>
          )}
        </div>
      }
      state={
        notStarted ? (
          <NoResults title="Not sent yet" description="Recipients are picked when the campaign starts, so new customers and opt-outs are respected." />
        ) : list.isPending ? (
          <LoadingRows rows={4} label="Loading recipients" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <NoResults title={status ? 'Nobody with this status' : 'No recipients'} description={status ? undefined : c.status === 'failed' ? 'The campaign stopped before anyone was messaged.' : undefined} />
        ) : undefined
      }
      footer={
        list.hasNextPage && (
          <div className="flex justify-center px-4 py-3">
            <Button variant="secondary" size="sm" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )
      }
    />
  );
}

export default CampaignDetailPage;
