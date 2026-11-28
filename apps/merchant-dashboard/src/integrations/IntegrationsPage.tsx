import type { CourierAccount, CourierProvider, GatewayProvider, IntegrationSummary, PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, formatCount, ProviderLogo, Skeleton } from '@storeplix/ui';
import { Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { CourierDialog } from '../couriers/CourierDialog';
import { courierConnected, courierFooter, courierMeta, COURIERS, couriersByProvider, courierStatusMeta } from '../couriers/couriers';
import { useCouriers } from '../couriers/queries';
import { PageHeader } from '../layout/PageHeader';
import { can } from '../lib/permissions';
import { DEVELOPER_DOCS_URL } from '../lib/links';
import { ConnectGatewayDialog } from '../payments/ConnectGatewayDialog';
import { byProvider, GATEWAYS, gatewayMeta, integrationStatusMeta, isConnected, modeLabel } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';
import { useSmsCredits } from '../sms/queries';
import { canOpenSms } from '../sms/sms';
import { GatewayLogo } from '../payments/GatewayLogo';
import { ProviderTile } from './components';
import { attentionText, canViewIntegrations, FEED_ORDER, featurePlan, integrationPath, isLive, PROVIDER_META, statusMeta, TRACKING_ORDER, type PartAProvider } from './integrations';
import { useIntegrationList } from './queries';

// Figma Integrations 14:980 (PHASE-5B §10). Filter chips All / Connected / Couriers / Payments with counts. Payments
// (bKash, SSLCommerz) live since 5b-2; couriers (Steadfast, Pathao, RedX) since 5b-3: status badge, capability line,
// "Live mode · Synced 2 min ago" and Connect/Manage, which opens the courier dialog (couriers/CourierDialog).
// Hidden (§10): Paperfly, CarryBee, Nagad, EPS, aamarPay, PayStation, Marketing & tracking, AI.
// PHASE-8-9A §12.6 (Q271): Messaging is no longer hidden: one SMS card (platform gateway, always Active) → /integrations/sms,
// shown to members who can open that page (settings.manage | integrations.manage | billing.view), plus a "Messaging"
// chip. The SMS card is not counted in the All/Connected chip numbers (those count connectable accounts).
// Phase 8.4 §7: the Developer banner 14:1441 links to /integrations/developer (only with `developers.manage`). Filter pills follow the Figma frames (selected = text-primary fill, white text; counts on All and
// Connected only); the search box filters the cards by name. Staff see the page read-only.
// PHASE-8-9D P89D-50 (Figma 2143:59642, mobile 2136:1866): groups "Marketing & tracking" (Meta Pixel, TikTok, GA4, GTM
// server; "IDs and tokens only") and "Sales channels" (Facebook & Instagram catalog, Google Merchant Center) from
// `GET …/integrations`, with chips, shown to `integrations.manage | marketing.manage`; plan-gated cards show "Upgrade".

type Filter = 'all' | 'connected' | 'couriers' | 'payments' | 'messaging' | 'tracking' | 'channels';
const FILTERS: readonly Filter[] = ['all', 'connected', 'couriers', 'payments', 'messaging', 'tracking', 'channels'];

export function IntegrationsPage() {
  const scope = useStoreScope();
  const { activeTenant } = useAuth();
  const gateways = usePaymentGateways();
  const [params] = useSearchParams();
  const initial = params.get('filter');
  const [filter, setFilter] = useState<Filter>(FILTERS.includes(initial as Filter) ? (initial as Filter) : 'all');
  const smsVisible = canOpenSms(activeTenant);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const couriers = useCouriers();
  const [connecting, setConnecting] = useState<GatewayProvider | null>(null);
  const [courier, setCourier] = useState<CourierProvider | null>(null);
  const accounts = byProvider(gateways.data);
  const courierAccounts = couriersByProvider(couriers.data);
  const trackingVisible = canViewIntegrations(activeTenant);
  const integrations = useIntegrationList();
  const summaries = new Map<string, IntegrationSummary>((integrations.data ?? []).map((i) => [i.provider, i]));
  const partA: PartAProvider[] = trackingVisible ? [...TRACKING_ORDER, ...FEED_ORDER] : [];
  const integrationConnected = (p: PartAProvider) => isLive(summaries.get(p)?.status ?? 'not_connected');
  const connectedCount = GATEWAYS.filter((p) => isConnected(accounts[p])).length + COURIERS.filter((p) => courierConnected(courierAccounts[p])).length + partA.filter(integrationConnected).length;
  const chips: { value: Filter; label: string }[] = [
    { value: 'all', label: `All · ${GATEWAYS.length + COURIERS.length + partA.length}` },
    { value: 'connected', label: `Connected · ${connectedCount}` },
    { value: 'couriers', label: 'Couriers' },
    { value: 'payments', label: 'Payments' },
    ...(trackingVisible ? [{ value: 'tracking' as const, label: 'Marketing & tracking' }] : []),
    ...(smsVisible ? [{ value: 'messaging' as const, label: 'Messaging' }] : []),
    ...(trackingVisible ? [{ value: 'channels' as const, label: 'Sales channels' }] : []),
  ];
  const showPayments = filter === 'all' || filter === 'connected' || filter === 'payments';
  const groupVisible = (group: 'tracking' | 'channels') => trackingVisible && (filter === 'all' || filter === 'connected' || filter === group);
  const visibleIntegrations = (order: PartAProvider[]) => order.filter((p) => (filter !== 'connected' || integrationConnected(p)) && matches(PROVIDER_META[p].name));
  const showMessaging = smsVisible && (filter === 'all' || filter === 'connected' || filter === 'messaging') && matches('Storeplix SMS');
  const visibleGateways = GATEWAYS.filter((p) => (filter !== 'connected' || isConnected(accounts[p])) && matches(gatewayMeta[p].name));
  const showCouriers = filter === 'all' || filter === 'connected' || filter === 'couriers';
  const visibleCouriers = COURIERS.filter((p) => (filter !== 'connected' || courierConnected(courierAccounts[p])) && matches(courierMeta[p].name));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        subtitle="Connect your own accounts. Money always goes straight to you — Store Plix never holds it."
        actions={
          <label className="flex h-10 w-full items-center gap-2 rounded-control border border-border-default bg-surface-card px-3 focus-within:border-brand-600 sm:w-65">
            <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
            <input
              type="search"
              aria-label="Search integrations"
              placeholder="Search integrations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
        }
      />
      <div role="group" aria-label="Filter integrations" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {chips.map((c) => {
          const on = filter === c.value;
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(c.value)}
              className={cn(
                'shrink-0 rounded-full px-3.5 py-2 text-body font-medium whitespace-nowrap outline-none focus-visible:shadow-focus',
                on ? 'bg-text-primary text-text-inverse' : 'bg-surface-card text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)] hover:bg-surface-subtle',
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can connect or change integrations.</p>}

      {showCouriers && (
        <Section title="Couriers" subtitle="Book parcels and sync their status from Store Plix.">
          {couriers.isPending ? (
            <>
              <Skeleton className="h-[185px] rounded-card" />
              <Skeleton className="h-[185px] rounded-card" />
              <Skeleton className="h-[185px] rounded-card" />
            </>
          ) : couriers.isError ? (
            <div className="sm:col-span-2 xl:col-span-3">
              <ErrorBlock title="We couldn’t load your couriers" error={couriers.error} onRetry={() => void couriers.refetch()} />
            </div>
          ) : visibleCouriers.length === 0 ? (
            <p className="text-body text-text-muted sm:col-span-2 xl:col-span-3">{q ? 'No courier matches your search.' : 'No courier connected yet.'}</p>
          ) : (
            visibleCouriers.map((p) => <CourierCard key={p} provider={p} account={courierAccounts[p]} canManage={scope.canManageIntegrations} onOpen={() => setCourier(p)} />)
          )}
        </Section>
      )}

      {showPayments && (
        <Section title="Payments" subtitle="Customers pay into your own merchant account.">
          {gateways.isPending ? (
            <>
              <Skeleton className="h-[185px] rounded-card" />
              <Skeleton className="h-[185px] rounded-card" />
            </>
          ) : gateways.isError ? (
            <div className="sm:col-span-2 xl:col-span-3">
              <ErrorBlock title="We couldn’t load your payment gateways" error={gateways.error} onRetry={() => void gateways.refetch()} />
            </div>
          ) : visibleGateways.length === 0 ? (
            <p className="text-body text-text-muted sm:col-span-2 xl:col-span-3">{q ? 'No payment gateway matches your search.' : 'No payment gateway connected yet.'}</p>
          ) : (
            visibleGateways.map((p) => <GatewayCard key={p} provider={p} account={accounts[p]} canManage={scope.canManageIntegrations} onOpen={() => setConnecting(p)} />)
          )}
        </Section>
      )}

      {groupVisible('tracking') && (
        <IntegrationGroup
          title="Marketing & tracking"
          subtitle="IDs and tokens only — send purchases to ad platforms so your ads find buyers."
          providers={visibleIntegrations(TRACKING_ORDER)}
          query={integrations}
          summaries={summaries}
          canManage={scope.canManageIntegrations}
          empty={q ? 'No tracking integration matches your search.' : 'No tracking connected yet.'}
        />
      )}

      {showMessaging && (
        <Section title="Messaging" subtitle="Order updates and codes by SMS, sent through Store Plix.">
          <SmsCard />
        </Section>
      )}

      {groupVisible('channels') && (
        <IntegrationGroup
          title="Sales channels"
          subtitle="Show your products on Facebook, Instagram and Google. Orders still come to your shop."
          providers={visibleIntegrations(FEED_ORDER)}
          query={integrations}
          summaries={summaries}
          canManage={scope.canManageIntegrations}
          empty={q ? 'No sales channel matches your search.' : 'No sales channel connected yet.'}
        />
      )}

      {filter === 'all' && !q && can.manageDevelopers(activeTenant) && <DeveloperBanner />}

      {connecting && <ConnectGatewayDialog provider={connecting} account={accounts[connecting]} onClose={() => setConnecting(null)} />}
      {courier && <CourierDialog provider={courier} account={courierAccounts[courier]} onClose={() => setCourier(null)} />}
    </div>
  );
}

/** Figma Developer banner 14:1441: ink card (radius 16, px 24 py 18, gap 16), Body/16 Medium inverse title, Caption
 * muted line, secondary sm "Read API docs" (only with a docs URL) + primary sm "Create API key". */
function DeveloperBanner() {
  return (
    <section aria-label="Developer" className="flex flex-col gap-4 rounded-card bg-text-primary px-6 py-[18px] sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-body-lg font-medium text-text-inverse">
          <Link to="/integrations/developer" className="rounded-sm outline-none hover:underline focus-visible:shadow-focus">
            Developer: API keys and webhooks
          </Link>
        </h2>
        <p className="text-caption text-text-muted">Send orders to Google Sheets, your accounting tool or a custom app. Signed webhooks, scoped keys.</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-4">
        {DEVELOPER_DOCS_URL && (
          <a href={DEVELOPER_DOCS_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Read API docs
          </a>
        )}
        <Link to="/integrations/developer?create=key" className={buttonVariants({ size: 'sm' })}>
          Create API key
        </Link>
      </div>
    </section>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        <p className="text-caption text-text-muted">{subtitle}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

export function IntegrationCard({ logo, name, status, capability, footer, action, highlighted }: { logo: ReactNode; name: string; status: ReactNode; capability: string; footer: ReactNode; action?: ReactNode; highlighted?: boolean }) {
  return (
    <article aria-label={name} className={cn('flex min-h-[185px] flex-col gap-3.5 rounded-card border bg-surface-card p-[18px] shadow-elevation-1', highlighted ? 'border-brand-100' : 'border-border-default')}>
      <div className="flex items-center gap-3">
        {logo}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <h3 className="w-full truncate text-body font-semibold text-text-primary">{name}</h3>
          {status}
        </div>
      </div>
      <p className="flex-1 text-caption text-text-secondary">{capability}</p>
      <div className="flex min-h-11 items-center gap-2 border-t border-border-default pt-3">
        <p className="min-w-0 flex-1 text-caption text-text-muted">{footer}</p>
        {action}
      </div>
    </article>
  );
}

function IntegrationGroup({
  title,
  subtitle,
  providers,
  query,
  summaries,
  canManage,
  empty,
}: {
  title: string;
  subtitle: string;
  providers: PartAProvider[];
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  summaries: Map<string, IntegrationSummary>;
  canManage: boolean;
  empty: string;
}) {
  return (
    <Section title={title} subtitle={subtitle}>
      {query.isPending ? (
        <>
          <Skeleton className="h-[185px] rounded-card" />
          <Skeleton className="h-[185px] rounded-card" />
        </>
      ) : query.isError ? (
        <div className="sm:col-span-2 xl:col-span-3">
          <ErrorBlock title={`We couldn’t load ${title.toLowerCase()}`} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : providers.length === 0 ? (
        <p className="text-body text-text-muted sm:col-span-2 xl:col-span-3">{empty}</p>
      ) : (
        providers.map((p) => <PartACard key={p} provider={p} summary={summaries.get(p)} canManage={canManage} />)
      )}
    </Section>
  );
}

/** PHASE-8-9D card: status pill (or "Upgrade · plan"), one-line summary, attention/footer and Connect / Manage. */
function PartACard({ provider, summary, canManage }: { provider: PartAProvider; summary: IntegrationSummary | undefined; canManage: boolean }) {
  const meta = PROVIDER_META[provider];
  const status = summary?.status ?? 'not_connected';
  const live = isLive(status) || status === 'setup_required';
  const gate = summary?.plan_required === 'product_feeds' || summary?.plan_required === 'server_side_tagging' ? summary.plan_required : null;
  const s = statusMeta(status);
  const attention = summary?.attention.find((a) => a.reason !== 'plan_required');
  const footer = attention ? attentionText(attention, provider) : gate && !live ? `${featurePlan[gate]} plan` : live ? meta.typePill : 'Uses your own account';
  const label = live ? 'Manage' : gate ? 'View' : canManage ? 'Connect' : 'View';
  return (
    <IntegrationCard
      logo={<ProviderTile provider={provider} size="md" />}
      name={meta.name}
      status={
        gate && !live ? (
          <Badge tone="brand">Upgrade · {featurePlan[gate]}</Badge>
        ) : (
          <Badge tone={s.tone} dot={status === 'connected'}>
            {s.label}
          </Badge>
        )
      }
      capability={summary?.summary ?? meta.capability}
      footer={footer}
      highlighted={status === 'connected'}
      action={
        <Link to={integrationPath(provider)} aria-label={`${label} ${meta.name}`} className={buttonVariants({ variant: label === 'Connect' ? 'primary' : 'secondary', size: 'sm' })}>
          {label}
        </Link>
      }
    />
  );
}

/** PHASE-8-9A §12.6 SMS card: logo tile "SMS", Active, capability + credit balance, Manage → /integrations/sms. */
function SmsCard() {
  const credits = useSmsCredits();
  const balance = credits.data ? ` · ${formatCount(credits.data.balance)} credits` : '';
  return (
    <IntegrationCard
      logo={
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-600 text-caption font-semibold text-text-inverse">
          SMS
        </span>
      }
      name="Storeplix SMS"
      status={
        <Badge tone="success" dot>
          Active
        </Badge>
      }
      capability={`Order updates, checkout codes and receipts${balance}`}
      footer="Storeplix SMS · BTRC-approved"
      highlighted
      action={
        <Link to="/integrations/sms" aria-label="Manage SMS" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          Manage
        </Link>
      }
    />
  );
}

function GatewayCard({ provider, account, canManage, onOpen }: { provider: GatewayProvider; account: PaymentGatewayAccount | undefined; canManage: boolean; onOpen: () => void }) {
  const meta = gatewayMeta[provider];
  const connected = isConnected(account);
  const status = integrationStatusMeta(account?.status ?? 'not_connected');
  const footer = connected && account?.mode ? `${modeLabel[account.mode]} · ${account.enabled ? 'On at checkout' : 'Off at checkout'}${account.is_default ? ' · Default' : ''}` : 'Uses your own account';
  return (
    <IntegrationCard
      logo={<GatewayLogo provider={provider} />}
      name={meta.name}
      status={
        <Badge tone={status.tone} dot={connected}>
          {status.label}
        </Badge>
      }
      capability={account?.status === 'error' && account.last_error_code ? `${meta.capability}. Last check failed — open to fix the keys.` : meta.capability}
      footer={footer}
      highlighted={connected}
      action={
        canManage ? (
          <Button size="sm" variant={connected || account?.status === 'error' ? 'secondary' : 'primary'} onClick={onOpen} aria-label={`${connected ? 'Manage' : 'Connect'} ${meta.name}`}>
            {connected ? 'Manage' : 'Connect'}
          </Button>
        ) : undefined
      }
    />
  );
}

function CourierCard({ provider, account, canManage, onOpen }: { provider: CourierProvider; account: CourierAccount | undefined; canManage: boolean; onOpen: () => void }) {
  const meta = courierMeta[provider];
  const connected = courierConnected(account);
  const status = courierStatusMeta(account?.status ?? 'not_connected');
  return (
    <IntegrationCard
      logo={<ProviderLogo provider={provider} />}
      name={meta.name}
      status={
        <Badge tone={status.tone} dot={connected}>
          {status.label}
        </Badge>
      }
      capability={account?.status === 'error' ? `${meta.capability}. Last check failed — open to fix the keys.` : meta.capability}
      footer={courierFooter(account, (iso) => timeAgo(iso))}
      highlighted={account?.status === 'connected'}
      action={
        canManage ? (
          <Button size="sm" variant={connected ? 'secondary' : 'primary'} onClick={onOpen} aria-label={`${connected ? 'Manage' : 'Connect'} ${meta.name}`}>
            {connected ? 'Manage' : 'Connect'}
          </Button>
        ) : undefined
      }
    />
  );
}

export default IntegrationsPage;
