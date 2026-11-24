import type { CampaignChannel, CampaignListItem, CampaignStatus } from '@storeplix/types';
import { Badge, buttonVariants, cn, DataTable, Menu, Tabs, type DataTableColumn, type MenuEntry } from '@storeplix/ui';
import { Lock, MoreHorizontal } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { Cell2 } from '../catalog/ui';
import { campaignDate, campaignStatusMeta, channelMeta, whenLabel } from './campaigns';

// Shared Marketing pieces (Figma 66:19179 / 70:19774): tabs, status pill (Pill 39:9438 with dot), channel tag
// (Tag 39:4554), numbered section card (70:20184), the Recent campaigns table (66:19809) and the Starter plan note.

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  const m = campaignStatusMeta[status];
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

export function ChannelTag({ channel }: { channel: CampaignChannel }) {
  const m = channelMeta[channel];
  return (
    <Badge size="sm" tone={m.tone}>
      {m.label}
    </Badge>
  );
}

export type MarketingTab = 'overview' | 'coupons' | 'campaigns';

/** Overview · Coupons (n) · Campaigns (n); the Automations tab is hidden (8.6). */
export function MarketingTabs({ value, counts }: { value: MarketingTab; counts?: { coupons: number; campaigns: number } }) {
  const navigate = useNavigate();
  const to: Record<MarketingTab, string> = { overview: '/marketing', coupons: '/marketing/coupons', campaigns: '/marketing/campaigns' };
  return (
    <Tabs<MarketingTab>
      aria-label="Marketing sections"
      value={value}
      onChange={(v) => navigate(to[v])}
      items={[
        { value: 'overview', label: 'Overview' },
        { value: 'coupons', label: 'Coupons', count: counts?.coupons },
        { value: 'campaigns', label: 'Campaigns', count: counts?.campaigns },
      ]}
    />
  );
}

/** Card with the 28px numbered badge header (70:20185). */
export function StepCard({ step, title, description, children, className }: { step: number; title: string; description?: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)}>
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-caption font-medium text-brand-700">
          {step}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={id} className="text-body-lg font-medium text-text-primary">
            {title}
          </h2>
          {description && <p className="text-caption text-text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Plan note (same layout as the Developer page note): Free plan has no campaign allowance (P85-13). */
export function CampaignPlanNote({ canSeePlans }: { canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Campaigns are part of the Starter plan.</p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

export function campaignColumns(tz: string, menu?: (c: CampaignListItem) => MenuEntry[]): DataTableColumn<CampaignListItem>[] {
  const cols: DataTableColumn<CampaignListItem>[] = [
    {
      key: 'name',
      header: 'Campaign',
      mobileLabel: false,
      cell: (c) => <Cell2 top={c.name} bottom={whenLabel(campaignDate(c), tz)} topClass="font-semibold truncate" bottomClass="truncate" />,
    },
    { key: 'channel', header: 'Channel', width: 100, cell: (c) => <ChannelTag channel={c.channel} /> },
    { key: 'audience', header: 'Audience', width: 170, cell: (c) => <span className="text-body text-text-secondary md:line-clamp-2">{c.audience_label}</span> },
    { key: 'sent', header: 'Sent', width: 72, cell: (c) => <span className="text-body text-text-primary">{c.status === 'draft' || c.status === 'scheduled' ? '—' : formatCount(c.stats.sent)}</span> },
    { key: 'orders', header: 'Orders', width: 72, cell: (c) => <span className="text-body text-text-primary">{c.stats.orders > 0 ? formatCount(c.stats.orders) : '—'}</span> },
    { key: 'revenue', header: 'Revenue', width: 110, cell: (c) => <span className="text-body font-semibold text-text-primary">{c.stats.revenue_amount > 0 ? formatBdt(c.stats.revenue_amount) : '—'}</span> },
    { key: 'status', header: 'Status', width: 110, cell: (c) => <CampaignStatusPill status={c.status} /> },
  ];
  if (menu)
    cols.push({
      key: 'menu',
      header: <span className="sr-only">Actions</span>,
      width: 40,
      mobileLabel: false,
      align: 'end',
      cell: (c) => {
        const entries = menu(c);
        return (
          // The row is clickable: keep menu clicks from opening the campaign.
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex justify-end">
            <Menu
              label={`Actions for ${c.name}`}
              trigger={<MoreHorizontal aria-hidden className="size-[18px]" />}
              entries={entries}
              disabled={entries.length === 0}
              align="end"
              triggerClassName="size-7"
              className="w-[200px]"
            />
          </span>
        );
      },
    });
  return cols;
}

export function CampaignsTable({
  rows,
  tz,
  state,
  toolbar,
  footer,
  menu,
  label = 'Campaigns',
}: {
  rows: CampaignListItem[];
  tz: string;
  state?: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  menu?: (c: CampaignListItem) => MenuEntry[];
  label?: string;
}) {
  const navigate = useNavigate();
  return (
    <DataTable
      label={label}
      headTone="canvas"
      columns={campaignColumns(tz, menu)}
      rows={rows}
      getRowId={(c) => c.id}
      rowLabel={(c) => c.name}
      onRowClick={(c) => navigate(c.status === 'draft' ? `/marketing/campaigns/${c.id}/edit` : `/marketing/campaigns/${c.id}`)}
      toolbar={toolbar}
      footer={footer}
      state={state}
    />
  );
}
