import type { CampaignListItem, CampaignStatus } from '@storeplix/types';
import { buttonVariants, Dialog, Pagination, Tabs, type MenuEntry } from '@storeplix/ui';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { SearchBox, useDebounced } from '../catalog/ui';
import { PageHeader } from '../layout/PageHeader';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { campaignActions, campaignsLocked } from './campaigns';
import { useCampaignCommand, useCampaigns, useDeleteCampaign, useMarketingOverview } from './queries';
import { CampaignPlanNote, CampaignsTable, MarketingTabs } from './ui';

// PHASE-8-5 §8.2 Campaigns list, composed from Recent campaigns 66:19809 + Tab 39:9419: status tabs All / Scheduled /
// Sending / Sent / Drafts, name search, row menu (Edit, Duplicate, Unschedule, Cancel, Delete draft); empty state per
// 148:34032 with "+ New campaign". The table scrolls/stacks inside its card on mobile (Q151).

type Tab = 'all' | 'scheduled' | 'sending' | 'sent' | 'draft';
const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'draft', label: 'Drafts' },
];

type Confirm = { kind: 'cancel' | 'delete'; campaign: CampaignListItem } | null;

export function CampaignsPage() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const features = useFeatures();
  const locked = !features.data || campaignsLocked(features.data);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'all') as Tab;
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const page = Number(params.get('page') ?? '1') || 1;
  const status: CampaignStatus[] | undefined = tab === 'all' ? undefined : [tab];
  const list = useCampaigns({ status, q: debounced || undefined, page, per_page: 25 });
  const counts = useMarketingOverview('30d').data?.counts;
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';

  const command = useCampaignCommand();
  const remove = useDeleteCampaign();
  const [confirm, setConfirm] = useState<Confirm>(null);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const run = (c: CampaignListItem, cmd: 'unschedule' | 'duplicate' | 'cancel') =>
    command.mutate(
      { id: c.id, command: cmd },
      {
        onSuccess: (row) => {
          setConfirm(null);
          if (cmd === 'duplicate') {
            toast(`“${row.name}” created as a draft.`);
            navigate(`/marketing/campaigns/${row.id}/edit`);
          } else toast(cmd === 'unschedule' ? `“${c.name}” moved back to drafts.` : `“${c.name}” cancelled.`);
        },
        onError: (e) => toast(errorMessage(e), 'error'),
      },
    );

  const menu = (c: CampaignListItem): MenuEntry[] => {
    const a = campaignActions(c.status);
    const out: MenuEntry[] = [];
    if (a.edit) out.push({ key: 'edit', label: 'Edit', onSelect: () => navigate(`/marketing/campaigns/${c.id}/edit`) });
    out.push({ key: 'duplicate', label: 'Duplicate', disabled: locked, onSelect: () => run(c, 'duplicate') });
    if (a.unschedule) out.push({ key: 'unschedule', label: 'Unschedule', onSelect: () => run(c, 'unschedule') });
    if (a.cancel && c.status !== 'draft') out.push({ key: 'cancel', label: 'Cancel campaign', danger: true, onSelect: () => setConfirm({ kind: 'cancel', campaign: c }) });
    if (a.remove) out.push({ key: 'delete', label: 'Delete draft', danger: true, onSelect: () => setConfirm({ kind: 'delete', campaign: c }) });
    return out;
  };

  const filtered = !!(debounced || tab !== 'all');

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="SMS and email messages to your customers. Opted-out customers are never messaged."
        actions={
          locked ? (
            <button type="button" disabled className={buttonVariants()}>
              + New campaign
            </button>
          ) : (
            <Link to="/marketing/campaigns/new" className={buttonVariants()}>
              + New campaign
            </Link>
          )
        }
      />
      <MarketingTabs value="campaigns" counts={counts} />
      {features.data && locked && <CampaignPlanNote canSeePlans={scope.canViewBilling} />}
      <CampaignsTable
        rows={rows}
        tz={tz}
        menu={menu}
        toolbar={
          <div className="flex flex-col gap-3 px-4 pt-3.5 pb-3">
            <Tabs aria-label="Campaign status" value={tab} onChange={(v) => set({ tab: v === 'all' ? null : v })} items={TABS} />
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                set({ q: v });
              }}
              placeholder="Search campaigns"
              label="Search campaigns"
              className="h-[38px] w-full border border-border-default bg-surface-card sm:max-w-[260px] [&>svg]:size-4"
            />
          </div>
        }
        state={
          list.isPending ? (
            <LoadingRows label="Loading campaigns" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            filtered ? (
              <NoResults
                title={debounced ? `No campaigns match “${debounced}”` : 'No campaigns here'}
                onClear={() => {
                  setQ('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
                clearLabel="Clear filters"
              />
            ) : (
              <NoResults
                title="No campaigns yet"
                description="Send a Bangla or English SMS or an email to a segment of your customers."
                onClear={locked ? undefined : () => navigate('/marketing/campaigns/new')}
                clearLabel="+ New campaign"
              />
            )
          ) : undefined
        }
        footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="campaigns" onPage={(p) => set({ page: String(p) })} />}
      />

      <Dialog
        open={confirm?.kind === 'cancel'}
        title="Cancel this campaign?"
        description={confirm?.campaign.status === 'sending' ? 'Messages already sent stay sent. Nobody else will get it.' : 'It won’t be sent. You can duplicate it later.'}
        confirmLabel="Cancel campaign"
        cancelLabel="Keep it"
        tone="danger"
        loading={command.isPending}
        onConfirm={() => confirm && run(confirm.campaign, 'cancel')}
        onCancel={() => setConfirm(null)}
      />
      <Dialog
        open={confirm?.kind === 'delete'}
        title="Delete this draft?"
        description="The draft is removed for good."
        confirmLabel="Delete draft"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() =>
          confirm &&
          remove.mutate(confirm.campaign.id, {
            onSuccess: () => {
              toast('Draft deleted.');
              setConfirm(null);
            },
            onError: (e) => toast(errorMessage(e), 'error'),
          })
        }
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

export default CampaignsPage;
