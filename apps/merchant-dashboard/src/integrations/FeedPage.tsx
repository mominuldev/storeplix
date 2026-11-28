import type { CatalogItem, CatalogItemFilters, CatalogSyncRun, CatalogItemIssue, CatalogReviewStatus, FeedProvider, FeedCondition, GoogleMerchantSettings, MetaCatalogSettings, StoreIntegration } from '@storeplix/types';
import { Badge, Button, Checkbox, cn, Drawer, formatCount, Input, Select, Skeleton, Toggle } from '@storeplix/ui';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useCategories } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { can as perm } from '../lib/permissions';
import { toast } from '../online-store/components/Toast';
import { formatDate } from '../plan/billing';
import { KeyValue } from '../sms/components';
import {
  Banner,
  Breadcrumb,
  Columns,
  connectedMeta,
  ConnectionCheckCard,
  CopyRow,
  DetailTabs,
  DisconnectDialog,
  IntegrationHeader,
  Panel,
  PausedBanner,
  ProviderTile,
  ReadOnlyField,
  SettingRow,
  TableCard,
  TableHead,
  tdClass,
  Tip,
  UpgradeState,
} from './components';
import {
  attentionText,
  excludedReasonLabel,
  FEED_TAB_LABELS,
  FEED_TABS,
  integrationErrorText,
  isLive,
  isOauthReason,
  isSafeAuthorizeUrl,
  oauthErrorText,
  parseTab,
  PROVIDER_META,
  reviewMeta,
  syncResult,
  syncStatusMeta,
  syncTriggerLabel,
  type FeedTab,
} from './integrations';
import { useCatalogItems, useChooseAccount, useClaimWebsite, useFeedAccounts, useFeedOverview, useIntegration, useOauthStart, useSyncNow, useSyncRuns, useUpdateSettings } from './queries';

// PHASE-8-9D §7–§8 product feeds: Facebook & Instagram catalog `/integrations/meta-catalog` (Figma 2134:65506) and
// Google Merchant Center `/integrations/google-merchant` (2134:66100). Plan `product_feeds`. OAuth: start → redirect
// to the provider → the API callback 303s back here with `?oauth=success|error&reason=` → choose a catalog / account
// (status `setup_required`) → connected. Tabs Overview · Products · Sync history · Settings; issues drawer
// (2141:57154) links each issue to the product editor; Google "Verify and claim website" (P89D-32). Disconnect dialog
// 2135:55626.

/** Indirection so tests can observe the OAuth redirect without navigating jsdom. */
export const oauthNavigation = { assign: (url: string) => window.location.assign(url) };

const STOPS: Record<FeedProvider, string[]> = {
  meta_catalog: ['Hourly sync of your products', 'Price and stock updates within 15 minutes', 'Product tags in new Instagram posts', 'Catalog ads keep running with old prices — pause them in Meta'],
  google_merchant: ['Hourly sync of your products', 'Price and stock updates within 15 minutes', 'Free listings keep the last prices until Google removes them'],
};
const KEEP: Record<FeedProvider, string> = {
  meta_catalog: 'Products already in your Meta catalog stay there.',
  google_merchant: 'Products already in Merchant Center stay there.',
};
const SOURCE: Record<FeedProvider, string> = { meta_catalog: 'Meta', google_merchant: 'Google' };

const issueFixHref = (item: CatalogItem, issue: CatalogItemIssue): string | null => {
  if (issue.fix === 'product_editor') return item.product ? `/products/${item.product.id}` : null;
  if (issue.fix === 'feed_settings') return '?tab=settings';
  if (issue.fix === 'store_settings') return '/settings/store';
  return null;
};
const fixLabel = (issue: Pick<CatalogItemIssue, 'fix' | 'attribute'>) => {
  if (issue.fix === 'feed_settings') return 'Change feed settings';
  if (issue.fix === 'store_settings') return 'Open store settings';
  const a = issue.attribute ?? '';
  if (/image/.test(a)) return 'Replace photo in product editor';
  if (/price/.test(a)) return 'Edit price';
  if (/description/.test(a)) return 'Edit description';
  if (/brand/.test(a)) return 'Add brand';
  if (/gtin|barcode/.test(a)) return 'Add barcode';
  if (/category/.test(a)) return 'Change category';
  return 'Fix in product editor';
};

export function FeedPage({ provider }: { provider: FeedProvider }) {
  const scope = useStoreScope();
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const row = useIntegration(provider);
  const [params, setParams] = useSearchParams();
  const tab = parseTab<FeedTab>(params.get('tab'), FEED_TABS);
  const oauth = params.get('oauth');
  const reason = params.get('reason');
  const issuesOpen = params.get('issues') === '1';
  const [disconnecting, setDisconnecting] = useState(false);
  const sync = useSyncNow(provider);
  const canSeePlans = perm.viewBilling(activeTenant);

  // OAuth return: a success toast once, then drop the param (the error banner stays until dismissed).
  useEffect(() => {
    if (oauth === 'success') {
      toast(`Signed in with ${SOURCE[provider]}. Choose where to send your products.`);
      const p = new URLSearchParams(params);
      p.delete('oauth');
      p.delete('reason');
      setParams(p, { replace: true });
    }
  }, [oauth, params, provider, setParams]);

  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p);
  };
  const go = (t: FeedTab) => setParam('tab', t === 'overview' ? null : t);
  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: () => toast('Sync started. It usually takes a few minutes.'),
      onError: (e) => toast(integrationErrorText(e, provider), 'error'),
    });

  const oauthBanner =
    oauth === 'error' ? (
      <Banner
        tone="danger"
        action={
          <button
            type="button"
            className="shrink-0 font-semibold underline"
            onClick={() => {
              // One update for both keys: two setParam calls would each start from the same stale params.
              const p = new URLSearchParams(params);
              p.delete('oauth');
              p.delete('reason');
              setParams(p, { replace: true });
            }}
          >
            Dismiss
          </button>
        }
      >
        {isOauthReason(reason) ? oauthErrorText[reason] : 'We couldn’t connect. Try again.'}
      </Banner>
    ) : null;

  if (row.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading integration">
        <Breadcrumb provider={provider} />
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (row.isError) {
    return (
      <div className="flex flex-col gap-5">
        <Breadcrumb provider={provider} />
        <StateCard>
          <ErrorBlock title={`We couldn’t load ${PROVIDER_META[provider].name}`} error={row.error} onRetry={() => void row.refetch()} />
        </StateCard>
      </div>
    );
  }
  const data = row.data;
  const manage = scope.canManageIntegrations && data.can.manage && !readOnly;
  const live = isLive(data.status);
  const gated = data.plan_required === 'product_feeds';

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb provider={provider} />
      <IntegrationHeader
        provider={provider}
        status={data.status}
        meta={live ? connectedMeta(data) : [{ icon: 'shield', text: 'Starter and Growth plans · sign in with your own account' }]}
        primary={
          live && manage && data.can.sync_now && !gated ? (
            <Button loading={sync.isPending} onClick={runSync}>
              Sync now
            </Button>
          ) : undefined
        }
        onDisconnect={(live || data.status === 'setup_required') && manage ? () => setDisconnecting(true) : undefined}
      />
      {oauthBanner}
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can connect or change integrations.</p>}

      {!live && data.status !== 'setup_required' ? (
        gated ? <UpgradeState feature="product_feeds" canSeePlans={canSeePlans} /> : <ConnectCard provider={provider} manage={manage} />
      ) : data.status === 'setup_required' ? (
        <AccountChooser provider={provider} manage={manage} shopName={scope.store?.name ?? 'your shop'} />
      ) : (
        <>
          <DetailTabs label={`${PROVIDER_META[provider].name} sections`} value={tab} onChange={go} items={FEED_TABS.map((t) => ({ value: t, label: FEED_TAB_LABELS[t] }))} />
          {gated && <PausedBanner feature="product_feeds" canSeePlans={canSeePlans} />}
          {data.attention
            .filter((a) => a.reason !== 'plan_required' && a.reason !== 'website_not_claimed')
            .map((a) => (
              <Banner key={a.reason} tone={data.status === 'error' ? 'danger' : 'warning'}>
                {attentionText(a, provider)}
              </Banner>
            ))}
          {tab === 'overview' && <FeedOverviewTab provider={provider} row={data} manage={manage} onOpenIssues={() => setParam('issues', '1')} onHistory={() => go('history')} />}
          {tab === 'products' && <ProductsTab provider={provider} onOpenIssues={() => setParam('issues', '1')} />}
          {tab === 'history' && <HistoryTab provider={provider} />}
          {tab === 'settings' && <FeedSettingsTab provider={provider} row={data} manage={manage} />}
        </>
      )}

      {issuesOpen && live && <IssuesDrawer provider={provider} canSync={manage && data.can.sync_now && !gated} syncing={sync.isPending} onSync={runSync} onClose={() => setParam('issues', null)} />}
      {disconnecting && <DisconnectDialog provider={provider} stops={STOPS[provider]} keepNote={KEEP[provider]} onClose={() => setDisconnecting(false)} />}
    </div>
  );
}

// ---------- Connect (OAuth start) ----------

function ConnectCard({ provider, manage }: { provider: FeedProvider; manage: boolean }) {
  const start = useOauthStart(provider);
  const meta = PROVIDER_META[provider];
  return (
    <Columns
      left={
        <Panel title={`Connect ${meta.name}`} description={provider === 'meta_catalog' ? 'Sign in with Facebook and choose a catalog. Storeplix uses the Catalog API — no feed file to upload.' : 'Sign in with Google and choose your Merchant Center account. Storeplix keeps the product feed up to date.'}>
          <ul className="flex flex-col gap-2 text-body text-text-secondary">
            <li>· Every active, published product with a price and a photo is sent, one item per variant.</li>
            <li>· Prices and stock update within 15 minutes; everything is re-checked every hour.</li>
            <li>· Item issues from {SOURCE[provider]} show up here with a link to fix them.</li>
          </ul>
          {start.error ? <Banner tone="danger">{integrationErrorText(start.error, provider)}</Banner> : null}
          {manage && (
            <Button
              className="self-start"
              loading={start.isPending}
              onClick={() =>
                start.mutate(undefined, {
                  onSuccess: (r) => {
                    if (isSafeAuthorizeUrl(r.authorize_url)) oauthNavigation.assign(r.authorize_url);
                    else toast('We couldn’t open the sign-in page. Try again.', 'error');
                  },
                })
              }
            >
              Continue with {provider === 'meta_catalog' ? 'Facebook' : 'Google'}
            </Button>
          )}
        </Panel>
      }
      right={<Tip title={meta.tip.title}>{meta.tip.body}</Tip>}
    />
  );
}

// ---------- Choose catalog / account (§7.2) ----------

function AccountChooser({ provider, manage, shopName }: { provider: FeedProvider; manage: boolean; shopName: string }) {
  const accounts = useFeedAccounts(provider, true);
  const choose = useChooseAccount(provider);
  const [picked, setPicked] = useState<string | null>(null);
  const isMeta = provider === 'meta_catalog';
  const list = accounts.data ?? [];
  return (
    <Panel title={isMeta ? 'Choose a catalog' : 'Choose your Merchant Center account'} description={isMeta ? 'Pick the catalog your products go to, or let Storeplix create one.' : 'Pick the Merchant Center account your products go to.'}>
      {accounts.isPending ? (
        <LoadingRows rows={3} label="Loading accounts" />
      ) : accounts.isError ? (
        <ErrorBlock title="We couldn’t load your accounts" error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <fieldset className="flex flex-col gap-2" disabled={!manage}>
          <legend className="sr-only">{isMeta ? 'Catalog' : 'Merchant Center account'}</legend>
          {list.length === 0 && !isMeta && (
            <p className="text-body text-text-secondary">
              No Merchant Center account found for this Google sign-in. Create one at merchants.google.com, then reload this page.
            </p>
          )}
          {list.map((a) => (
            <label key={a.id} className={cn('flex cursor-pointer items-center gap-3 rounded-control border px-4 py-3', picked === a.id ? 'border-brand-600 bg-brand-50' : 'border-border-default')}>
              <input type="radio" name="feed-account" value={a.id} checked={picked === a.id} onChange={() => setPicked(a.id)} className="accent-brand-600" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">{a.name}</span>
                <span className="text-caption text-text-secondary">
                  {[a.parent_name, a.item_count !== null ? `${formatCount(a.item_count)} items` : null, `ID ${a.id}`].filter(Boolean).join(' · ')}
                </span>
              </span>
            </label>
          ))}
          {isMeta && (
            <label className={cn('flex cursor-pointer items-center gap-3 rounded-control border px-4 py-3', picked === 'new' ? 'border-brand-600 bg-brand-50' : 'border-border-default')}>
              <input type="radio" name="feed-account" value="new" checked={picked === 'new'} onChange={() => setPicked('new')} className="accent-brand-600" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">Create a new catalog</span>
                <span className="text-caption text-text-secondary">Storeplix · {shopName}</span>
              </span>
            </label>
          )}
        </fieldset>
      )}
      {choose.error ? <Banner tone="danger">{integrationErrorText(choose.error, provider)}</Banner> : null}
      {manage && (
        <Button
          className="self-start"
          disabled={!picked}
          loading={choose.isPending}
          onClick={() =>
            picked &&
            choose.mutate(picked === 'new' ? { create_catalog: true } : { account_id: picked }, {
              onSuccess: () => toast('Connected. The first sync has started.'),
            })
          }
        >
          Connect and start syncing
        </Button>
      )}
    </Panel>
  );
}

// ---------- Overview ----------

function FeedOverviewTab({ provider, row, manage, onOpenIssues, onHistory }: { provider: FeedProvider; row: StoreIntegration<FeedProvider>; manage: boolean; onOpenIssues: () => void; onHistory: () => void }) {
  const overview = useFeedOverview(provider, true);
  const runs = useSyncRuns(provider, undefined, true);
  const claim = useClaimWebsite();
  const scope = useStoreScope();
  const s = row.settings;
  const isMeta = provider === 'meta_catalog';
  const meta = s && isMeta ? (s as MetaCatalogSettings) : null;
  const g = s && !isMeta ? (s as GoogleMerchantSettings) : null;
  const counts = overview.data?.counts;
  const host = scope.store?.primary_domain ?? 'your shop address';

  return (
    <Columns
      left={
        <>
          <Panel title={isMeta ? 'Catalog connection' : 'Merchant Center account'} description={isMeta ? 'Storeplix uses the Catalog API — no feed file to upload.' : 'Storeplix sends your products with the Merchant API.'}>
            {g && !g.website_claimed && (
              <Banner tone="warning">Website not claimed yet. Google shows products only after {host} is verified. Storeplix adds Google’s verification meta tag for you — nothing to paste.</Banner>
            )}
            <div className="flex flex-col gap-4 sm:flex-row">
              {meta?.catalog_id ? <CopyRow label="Catalog ID" value={meta.catalog_id} /> : g?.merchant_id ? <CopyRow label="Merchant Center ID" value={g.merchant_id} /> : <ReadOnlyField label="Account" value="—" />}
              <ReadOnlyField label={isMeta ? 'Business' : 'Website'} value={isMeta ? (meta?.business_name ?? meta?.catalog_name ?? '—') : `${host} · ${g?.website_claimed ? 'claimed' : 'not claimed'}`} />
            </div>
            <div className="flex flex-col gap-4 sm:flex-row">
              <ReadOnlyField label="Sync" value="Every hour · stock and price within 15 min" />
              <ReadOnlyField label={isMeta ? 'Currency and language' : 'Feed language'} value={isMeta ? `${scope.store?.currency ?? 'BDT'} · titles as written` : g?.feed_language === 'en' ? 'English' : 'বাংলা (Bangla)'} />
            </div>
            {g && !g.website_claimed && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 text-caption text-text-secondary">Takes under a minute. Your shop must be published (not Coming soon).</p>
                {manage && (
                  <Button loading={claim.isPending} onClick={() => claim.mutate(undefined, { onSuccess: () => toast('Website verified and claimed') })}>
                    Verify and claim website
                  </Button>
                )}
              </div>
            )}
            {claim.error ? <Banner tone="danger">{integrationErrorText(claim.error, provider)}</Banner> : null}
            {counts && counts.total > 0 && (g?.website_claimed ?? true) && (
              <Banner tone="success">
                {isMeta ? 'Catalog in sync' : 'Feed in sync'} · {formatCount(counts.approved)} of {formatCount(counts.total)} products live on {isMeta ? 'Facebook and Instagram' : 'Google'}
              </Banner>
            )}
          </Panel>

          {overview.isPending ? (
            <Skeleton className="h-48 rounded-card" />
          ) : overview.isError ? (
            <StateCard>
              <ErrorBlock title="We couldn’t load the feed overview" error={overview.error} onRetry={() => void overview.refetch()} />
            </StateCard>
          ) : overview.data.issues.length > 0 ? (
            <TableCard
              title={isMeta ? 'Products with issues' : 'Product issues from Google'}
              action={
                <button type="button" onClick={onOpenIssues} className="rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                  Fix all
                </button>
              }
            >
              <table className="w-full min-w-[560px]">
                <TableHead cols={[{ label: 'Issue' }, { label: 'Products' }, { label: 'Impact' }, { label: 'Fix' }]} />
                <tbody>
                  {overview.data.issues.map((i) => (
                    <tr key={i.code}>
                      <td className={cn(tdClass, 'text-text-primary')}>{i.message}</td>
                      <td className={tdClass}>{formatCount(i.products)}</td>
                      <td className={tdClass}>{i.impact ? <Badge tone={i.impact === 'disapproved' ? 'danger' : 'warning'} size="sm">{i.impact === 'disapproved' ? 'Disapproved' : 'Limited reach'}</Badge> : '—'}</td>
                      <td className={tdClass}>
                        <button type="button" onClick={onOpenIssues} className="rounded-sm font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                          {fixLabel({ fix: i.fix, attribute: i.code })}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          ) : null}

          <TableCard
            title="Sync history"
            action={
              <button type="button" onClick={onHistory} className="rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                View all
              </button>
            }
          >
            <RunsTable runs={runs.data?.data.slice(0, 4)} pending={runs.isPending} error={runs.isError ? runs.error : null} onRetry={() => void runs.refetch()} />
          </TableCard>
        </>
      }
      right={
        <>
          <Panel title={isMeta ? 'Products in catalog' : 'Product status'}>
            {overview.isPending ? (
              <LoadingRows rows={4} label="Loading product counts" />
            ) : overview.isError ? (
              <p className="text-body text-text-secondary">Counts aren’t available right now.</p>
            ) : (
              <ProductCounts counts={overview.data.counts} />
            )}
          </Panel>
          {overview.data && (overview.data.clicks_30d !== null || overview.data.next_full_sync_at) && (
            <Panel title="Last 30 days">
              <div className="flex flex-col gap-3">
                {overview.data.clicks_30d !== null && <KeyValue label={isMeta ? 'Product taps' : 'Clicks from free listings'} value={formatCount(overview.data.clicks_30d)} />}
                {overview.data.next_full_sync_at && <KeyValue label="Next full sync" value={formatDate(overview.data.next_full_sync_at, { short: true })} />}
              </div>
            </Panel>
          )}
          <ConnectionCheckCard provider={provider} canRun={manage} />
          <Tip title={PROVIDER_META[provider].tip.title}>{PROVIDER_META[provider].tip.body}</Tip>
        </>
      }
    />
  );
}

function ProductCounts({ counts }: { counts: { total: number; approved: number; in_review: number; with_issues: number; not_sent: number } }) {
  const pct = counts.total > 0 ? Math.round((counts.approved / counts.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-baseline gap-2">
        <span className="text-heading-32 font-bold text-text-primary">{formatCount(counts.approved)}</span>
        <span className="text-body text-text-secondary">of {formatCount(counts.total)} live</span>
      </p>
      <div className="h-2 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-label="Products live" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', counts.with_issues > 0 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
      </div>
      <KeyValue label="Approved" value={formatCount(counts.approved)} valueClassName="text-success" />
      <KeyValue label="In review" value={formatCount(counts.in_review)} />
      <KeyValue label="With issues" value={formatCount(counts.with_issues)} valueClassName={counts.with_issues > 0 ? 'text-danger' : undefined} />
      <KeyValue label="Not sent" value={formatCount(counts.not_sent)} />
    </div>
  );
}

function RunsTable({ runs, pending, error, onRetry }: { runs: CatalogSyncRun[] | undefined; pending: boolean; error: unknown; onRetry: () => void }) {
  if (pending) return <div className="px-6 pb-4"><LoadingRows rows={3} label="Loading sync history" /></div>;
  if (error) return <ErrorBlock title="We couldn’t load the sync history" error={error} onRetry={onRetry} />;
  if (!runs || runs.length === 0) return <p className="px-6 pb-6 text-body text-text-secondary">No syncs yet. The first one starts right after you connect.</p>;
  return (
    <table className="w-full min-w-[600px]">
      <TableHead cols={[{ label: 'Started' }, { label: 'Type' }, { label: 'Products' }, { label: 'Result' }, { label: 'Status' }]} />
      <tbody>
        {runs.map((r) => {
          const st = syncStatusMeta(r.status);
          return (
            <tr key={r.id}>
              <td className={cn(tdClass, 'font-medium whitespace-nowrap text-text-primary')}>
                {formatDate(r.started_at, { short: true })} {new Date(r.started_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className={tdClass}>{syncTriggerLabel[r.trigger]}</td>
              <td className={tdClass}>{formatCount(r.items_sent + r.items_failed)}</td>
              <td className={tdClass}>{syncResult(r)}</td>
              <td className={tdClass}>
                <Badge tone={st.tone} size="sm">
                  {st.label}
                </Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- Products ----------

type ItemChip = 'all' | 'approved' | 'in_review' | 'with_issues' | 'not_sent';
const ITEM_CHIPS: { value: ItemChip; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'in_review', label: 'In review' },
  { value: 'with_issues', label: 'With issues' },
  { value: 'not_sent', label: 'Not sent' },
];
function chipItemFilters(c: ItemChip): CatalogItemFilters {
  if (c === 'approved') return { review_status: ['approved'] };
  if (c === 'in_review') return { review_status: ['in_review'] };
  if (c === 'with_issues') return { has_issues: true };
  if (c === 'not_sent') return { status: ['excluded', 'pending'] };
  return {};
}

function Chips<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      {items.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          onClick={() => onChange(c.value)}
          className={cn(
            'shrink-0 rounded-full px-3.5 py-1.5 text-body font-medium whitespace-nowrap outline-none focus-visible:shadow-focus',
            value === c.value ? 'bg-brand-50 text-brand-700 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'bg-surface-card text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)] hover:bg-surface-subtle',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-control border border-border-default bg-surface-card px-3 focus-within:border-brand-600">
      <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
      <input type="search" aria-label={label} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted" />
    </label>
  );
}

function ProductsTab({ provider, onOpenIssues }: { provider: FeedProvider; onOpenIssues: () => void }) {
  const [chip, setChip] = useState<ItemChip>('all');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const items = useCatalogItems(provider, { ...chipItemFilters(chip), q: q.trim() || undefined, cursor: cursors[cursors.length - 1] }, true);
  const counts = items.data?.meta.counts;
  const countOf: Record<ItemChip, number | undefined> = { all: counts?.total, approved: counts?.approved, in_review: counts?.in_review, with_issues: counts?.with_issues, not_sent: counts?.not_sent };
  const rows = items.data?.data ?? [];
  const next = items.data?.meta.next_cursor ?? null;
  return (
    <TableCard title="Products in the feed" description="One item per variant. Only active, published products with a price and a photo are sent.">
      <div className="flex flex-col gap-3 px-4 pb-3 sm:px-6">
        <SearchBox
          label="Search product or SKU"
          value={q}
          onChange={(v) => {
            setQ(v);
            setCursors([]);
          }}
        />
        <Chips
          label="Show"
          value={chip}
          onChange={(c) => {
            setChip(c);
            setCursors([]);
          }}
          items={ITEM_CHIPS.map((c) => ({ value: c.value, label: countOf[c.value] !== undefined ? `${c.label} · ${formatCount(countOf[c.value]!)}` : c.label }))}
        />
      </div>
      {items.isPending ? (
        <div className="px-6 pb-4">
          <LoadingRows rows={5} label="Loading products" />
        </div>
      ) : items.isError ? (
        <ErrorBlock title="We couldn’t load the products" error={items.error} onRetry={() => void items.refetch()} />
      ) : rows.length === 0 ? (
        <p className="px-6 pb-8 pt-4 text-center text-body text-text-secondary">{q || chip !== 'all' ? 'No products match.' : 'No products in the feed yet. They appear after the first sync.'}</p>
      ) : (
        <>
          <table className="w-full min-w-[640px]">
            <TableHead cols={[{ label: 'Product' }, { label: 'SKU' }, { label: 'Status' }, { label: 'Issues' }, { label: 'Last synced' }]} />
            <tbody>
              {rows.map((it) => {
                const rv = it.status === 'excluded' ? { label: it.excluded_reason ? excludedReasonLabel[it.excluded_reason] : 'Not sent', tone: 'neutral' as const } : reviewMeta(it.review_status);
                return (
                  <tr key={it.id}>
                    <td className={cn(tdClass, 'text-text-primary')}>
                      {it.product ? (
                        <Link to={`/products/${it.product.id}`} className="font-medium hover:underline">
                          {it.product.name}
                        </Link>
                      ) : (
                        'Deleted product'
                      )}
                      {it.variant?.title ? <span className="text-text-secondary"> · {it.variant.title}</span> : null}
                    </td>
                    <td className={tdClass}>{it.variant?.sku ?? '—'}</td>
                    <td className={tdClass}>
                      <Badge tone={rv.tone} size="sm">
                        {rv.label}
                      </Badge>
                    </td>
                    <td className={tdClass}>
                      {it.issues.length > 0 ? (
                        <button type="button" onClick={onOpenIssues} className="rounded-sm font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                          {it.issues.length} {it.issues.length === 1 ? 'issue' : 'issues'}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={tdClass}>{it.last_synced_at ? formatDate(it.last_synced_at, { short: true }) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pager hasPrev={cursors.length > 0} next={next} onPrev={() => setCursors((c) => c.slice(0, -1))} onNext={(n) => setCursors((c) => [...c, n])} />
        </>
      )}
    </TableCard>
  );
}

function Pager({ hasPrev, next, onPrev, onNext }: { hasPrev: boolean; next: string | null; onPrev: () => void; onNext: (n: string) => void }) {
  if (!hasPrev && !next) return null;
  return (
    <div className="flex justify-end gap-2 border-t border-border-default px-4 py-3 sm:px-6">
      <Button size="sm" variant="secondary" disabled={!hasPrev} onClick={onPrev}>
        Previous
      </Button>
      <Button size="sm" variant="secondary" disabled={!next} onClick={() => next && onNext(next)}>
        Next
      </Button>
    </div>
  );
}

function HistoryTab({ provider }: { provider: FeedProvider }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const runs = useSyncRuns(provider, cursors[cursors.length - 1], true);
  return (
    <TableCard title="Sync history" description="Full syncs run every hour; price and stock changes go out within 15 minutes. Runs are kept 90 days.">
      <RunsTable runs={runs.data?.data} pending={runs.isPending} error={runs.isError ? runs.error : null} onRetry={() => void runs.refetch()} />
      <Pager hasPrev={cursors.length > 0} next={runs.data?.meta.next_cursor ?? null} onPrev={() => setCursors((c) => c.slice(0, -1))} onNext={(n) => setCursors((c) => [...c, n])} />
    </TableCard>
  );
}

// ---------- Settings ----------

function FeedSettingsTab({ provider, row, manage }: { provider: FeedProvider; row: StoreIntegration<FeedProvider>; manage: boolean }) {
  const update = useUpdateSettings(provider);
  const categories = useCategories();
  const s = (row.settings ?? row.defaults) as MetaCatalogSettings & GoogleMerchantSettings;
  const isMeta = provider === 'meta_catalog';
  const [brand, setBrand] = useState(s.default_brand ?? '');
  const off = !manage || update.isPending;
  const patch = (p: Partial<MetaCatalogSettings & GoogleMerchantSettings>) =>
    update.mutate({ settings: p, revision: row.revision } as never, { onSuccess: () => toast('Settings saved'), onError: (e) => toast(integrationErrorText(e, provider), 'error') });
  return (
    <Columns
      left={
        <Panel title={isMeta ? 'Catalog settings' : 'Feed settings'} label="Feed settings">
          <div className="flex flex-col">
            <SettingRow
              title="Products to include"
              description="Drafts and hidden products are never sent."
              control={
                <Select aria-label="Products to include" value={s.include} disabled={off} onChange={(e) => patch(e.target.value === 'all' ? { include: 'all', category_ids: [] } : { include: 'categories', category_ids: s.category_ids })}>
                  <option value="all">All active products</option>
                  <option value="categories">Only some categories</option>
                </Select>
              }
            />
            {s.include === 'categories' && (
              <div className="flex flex-col gap-2 border-b border-border-default py-3.5">
                <p className="text-body font-semibold text-text-primary">Categories</p>
                {categories.isPending ? (
                  <LoadingRows rows={2} label="Loading categories" />
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(categories.data ?? []).map((c) => {
                      const on = s.category_ids.includes(c.id);
                      return <Checkbox key={c.id} label={c.name} checked={on} disabled={off || (on && s.category_ids.length === 1)} onChange={(e) => patch({ category_ids: e.target.checked ? [...s.category_ids, c.id] : s.category_ids.filter((x) => x !== c.id) })} />;
                    })}
                  </div>
                )}
              </div>
            )}
            {isMeta ? (
              <SettingRow title="Hide sold-out products" description="Removed from ads; old Instagram tags stay but show “Sold out”." control={<Toggle label="Hide sold-out products" checked={s.hide_sold_out} disabled={off} onChange={(v) => patch({ hide_sold_out: v })} />} />
            ) : (
              <SettingRow title="Send sold-out products as “out of stock”" description="Keeps them listed so they come back faster when restocked." control={<Toggle label="Send sold-out products as out of stock" checked={!s.hide_sold_out} disabled={off} onChange={(v) => patch({ hide_sold_out: !v })} />} />
            )}
            <SettingRow
              title={isMeta ? 'Use sale price during discounts' : 'Send sale price during discounts'}
              description={isMeta ? 'Sends the compare-at price as the original price.' : 'Google checks it against your product page.'}
              control={<Toggle label="Use sale price during discounts" checked={s.use_sale_price} disabled={off} onChange={(v) => patch({ use_sale_price: v })} />}
            />
            {isMeta ? (
              <SettingRow
                title="Brand for products without one"
                description="Meta requires a brand on every product. Empty = your shop name."
                control={
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      patch({ default_brand: brand.trim() || null });
                    }}
                  >
                    <Input aria-label="Default brand" value={brand} maxLength={70} disabled={off} onChange={(e) => setBrand(e.target.value)} placeholder="Shop name" />
                    {manage && (
                      <Button type="submit" variant="secondary" disabled={off || (brand.trim() || null) === (s.default_brand ?? null)}>
                        Save
                      </Button>
                    )}
                  </form>
                }
              />
            ) : (
              <>
                <SettingRow
                  title="Condition"
                  description="Applied to every product unless set on the product."
                  control={
                    <Select aria-label="Condition" value={s.condition} disabled={off} onChange={(e) => patch({ condition: e.target.value as FeedCondition })}>
                      <option value="new">New</option>
                      <option value="used">Used</option>
                      <option value="refurbished">Refurbished</option>
                    </Select>
                  }
                />
                <SettingRow
                  title="Feed language"
                  description="The language your product titles and descriptions are written in."
                  control={
                    <Select aria-label="Feed language" value={s.feed_language} disabled={off} onChange={(e) => patch({ feed_language: e.target.value as 'bn' | 'en' })}>
                      <option value="bn">বাংলা (Bangla)</option>
                      <option value="en">English</option>
                    </Select>
                  }
                />
              </>
            )}
          </div>
        </Panel>
      }
      right={<Tip title={PROVIDER_META[provider].tip.title}>{PROVIDER_META[provider].tip.body}</Tip>}
    />
  );
}

// ---------- Issues drawer (2141:57154) ----------

type IssueChip = 'all' | 'disapproved' | 'limited';
function IssuesDrawer({ provider, canSync, syncing, onSync, onClose }: { provider: FeedProvider; canSync: boolean; syncing: boolean; onSync: () => void; onClose: () => void }) {
  const [chip, setChip] = useState<IssueChip>('all');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const review: CatalogReviewStatus[] | undefined = chip === 'disapproved' ? ['disapproved'] : chip === 'limited' ? ['limited'] : undefined;
  const items = useCatalogItems(provider, { has_issues: true, review_status: review, q: q.trim() || undefined, cursor: cursors[cursors.length - 1] }, true);
  const total = items.data?.meta.counts.with_issues;
  const rows = items.data?.data ?? [];
  return (
    <Drawer
      open
      side="right"
      width={520}
      onClose={onClose}
      title={
        <span className="flex items-center gap-3">
          <ProviderTile provider={provider} size="sm" />
          Products with issues{total !== undefined ? ` · ${formatCount(total)}` : ''}
        </span>
      }
      description={`${PROVIDER_META[provider].name} · checked by ${SOURCE[provider]}. Fix a product and it goes out with the next sync.`}
      footer={
        <div className="flex w-full items-center gap-2">
          <p className="min-w-0 flex-1 text-caption text-text-secondary">Fixed products leave this list after {SOURCE[provider]} checks them again.</p>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canSync && (
            <Button loading={syncing} onClick={onSync}>
              Sync now
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Chips
          label="Impact"
          value={chip}
          onChange={(c) => {
            setChip(c);
            setCursors([]);
          }}
          items={[
            { value: 'all', label: 'All' },
            { value: 'disapproved', label: 'Disapproved' },
            { value: 'limited', label: 'Limited reach' },
          ]}
        />
        <SearchBox
          label="Search product or SKU"
          value={q}
          onChange={(v) => {
            setQ(v);
            setCursors([]);
          }}
        />
        {items.isPending ? (
          <LoadingRows rows={4} label="Loading issues" />
        ) : items.isError ? (
          <ErrorBlock title="We couldn’t load the issues" error={items.error} onRetry={() => void items.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-body text-text-secondary">{q || chip !== 'all' ? 'No products match.' : 'No product issues. Nice work.'}</p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-card border border-border-default" aria-label="Products with issues">
            {rows.map((it) => {
              const rv = reviewMeta(it.review_status);
              return (
                <li key={it.id} className="flex gap-3 border-b border-border-default px-3.5 py-3.5 last:border-b-0">
                  <span aria-hidden className="size-11 shrink-0 rounded-control bg-surface-subtle" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-body font-medium text-text-primary">
                        {it.product?.name ?? 'Deleted product'}
                        {it.variant?.title ? ` · ${it.variant.title}` : ''}
                      </p>
                      {it.review_status && (
                        <Badge tone={rv.tone} size="sm">
                          {rv.label}
                        </Badge>
                      )}
                    </div>
                    {it.variant?.sku && <p className="text-caption text-text-muted">SKU {it.variant.sku}</p>}
                    {it.issues.map((issue) => {
                      const href = issueFixHref(it, issue);
                      return (
                        <div key={issue.code} className="flex flex-col gap-0.5">
                          <p className="text-body text-text-secondary">{issue.message}</p>
                          {href && (
                            <Link to={href} onClick={href.startsWith('?') ? onClose : undefined} className="self-start rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                              {fixLabel(issue)} ↗
                            </Link>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {(cursors.length > 0 || items.data?.meta.next_cursor) && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={!items.data?.meta.next_cursor} onClick={() => items.data?.meta.next_cursor && setCursors((c) => [...c, items.data!.meta.next_cursor!])}>
              Next
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
