import type { CourierAccount, CourierProvider, GatewayProvider, PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, cn, ProviderLogo, Skeleton } from '@storeplix/ui';
import { Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { CourierDialog } from '../couriers/CourierDialog';
import { courierConnected, courierFooter, courierMeta, COURIERS, couriersByProvider, courierStatusMeta } from '../couriers/couriers';
import { useCouriers } from '../couriers/queries';
import { PageHeader } from '../layout/PageHeader';
import { ConnectGatewayDialog } from '../payments/ConnectGatewayDialog';
import { byProvider, GATEWAYS, gatewayMeta, integrationStatusMeta, isConnected, modeLabel } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';

// Figma Integrations 14:980 (PHASE-5B §10). Filter chips All / Connected / Couriers / Payments with counts. Payments
// (bKash, SSLCommerz) live since 5b-2; couriers (Steadfast, Pathao, RedX) since 5b-3: status badge, capability line,
// "Live mode · Synced 2 min ago" and Connect/Manage, which opens the courier dialog (couriers/CourierDialog).
// Hidden (§10): Paperfly, CarryBee, Nagad, EPS, aamarPay, PayStation, Marketing & tracking, Messaging, AI, Developer
// banner. Filter pills follow the Figma frames (selected = text-primary fill, white text; counts on All and
// Connected only); the search box filters the cards by name. Staff see the page read-only.

type Filter = 'all' | 'connected' | 'couriers' | 'payments';

export function IntegrationsPage() {
  const scope = useStoreScope();
  const gateways = usePaymentGateways();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const couriers = useCouriers();
  const [connecting, setConnecting] = useState<GatewayProvider | null>(null);
  const [courier, setCourier] = useState<CourierProvider | null>(null);
  const accounts = byProvider(gateways.data);
  const courierAccounts = couriersByProvider(couriers.data);
  const connectedCount = GATEWAYS.filter((p) => isConnected(accounts[p])).length + COURIERS.filter((p) => courierConnected(courierAccounts[p])).length;
  const chips: { value: Filter; label: string }[] = [
    { value: 'all', label: `All · ${GATEWAYS.length + COURIERS.length}` },
    { value: 'connected', label: `Connected · ${connectedCount}` },
    { value: 'couriers', label: 'Couriers' },
    { value: 'payments', label: 'Payments' },
  ];
  const showPayments = filter !== 'couriers';
  const visibleGateways = GATEWAYS.filter((p) => (filter !== 'connected' || isConnected(accounts[p])) && matches(gatewayMeta[p].name));
  const showCouriers = filter !== 'payments';
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

      {connecting && <ConnectGatewayDialog provider={connecting} account={accounts[connecting]} onClose={() => setConnecting(null)} />}
      {courier && <CourierDialog provider={courier} account={courierAccounts[courier]} onClose={() => setCourier(null)} />}
    </div>
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

function GatewayCard({ provider, account, canManage, onOpen }: { provider: GatewayProvider; account: PaymentGatewayAccount | undefined; canManage: boolean; onOpen: () => void }) {
  const meta = gatewayMeta[provider];
  const connected = isConnected(account);
  const status = integrationStatusMeta(account?.status ?? 'not_connected');
  const footer = connected && account?.mode ? `${modeLabel[account.mode]} · ${account.enabled ? 'On at checkout' : 'Off at checkout'}${account.is_default ? ' · Default' : ''}` : 'Uses your own account';
  return (
    <IntegrationCard
      logo={<ProviderLogo provider={provider} />}
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
