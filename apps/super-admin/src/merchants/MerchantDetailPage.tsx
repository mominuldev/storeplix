import type { AdminTenant, AdminTenantMember, AdminTenantMetrics, BillingInvoiceStatus } from '@storeplix/types';
import {
  Avatar,
  Badge,
  BarChart,
  Button,
  Card,
  DataTable,
  Pagination,
  ProgressBar,
  Skeleton,
  Tabs,
  Toggle,
  formatBdtCompact,
  formatCount,
  type DataTableColumn,
} from '@storeplix/ui';
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Calendar, ChevronRight, ExternalLink, Globe, Phone, ScrollText, ShieldAlert, User, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { delta, monthShort } from '../analytics/format';
import { DeltaPill, NoAnalytics } from '../analytics/ui';
import { AuditTable } from '../audit/AuditTable';
import { CursorFooter } from '../audit/CursorFooter';
import { useCursorPages } from '../audit/useCursorPages';
import { InvoiceDrawer } from '../billing/InvoiceDrawer';
import { InvoicesTable } from '../billing/InvoicesTable';
import { TenantStatusBadge, tenantStatus } from '../components/badges';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { DomainsTable } from '../domains/DomainsTable';
import { api } from '../lib/api';
import { formatDate, intervalLabel, money, planName } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { AiCreditsCard, AiUsageRow } from '../ai/AiCredits';
import { SmsCreditsCard, SmsUsageRow } from '../sms/SmsCredits';
import { ChangePlanDialog, ExtendDialog, ReactivateDialog, SuspendDialog, extendLabel, suspensionReasons } from './dialogs';
import { ImpersonateDialog } from './ImpersonateDialog';

type TabKey = 'overview' | 'billing' | 'domains' | 'staff' | 'audit';
type DialogKey = 'plan' | 'extend' | 'suspend' | 'reactivate' | 'impersonate' | null;

const usageLabels: Record<string, string> = {
  orders_per_month: 'Orders this month',
  staff_seats: 'Staff accounts',
  products: 'Products',
  courier_connections: 'Courier connections',
  custom_domains: 'Custom domains',
};

// Merchant detail 33:4851 (§7.1): breadcrumb, header card (name, plan + status pills, host, owner, phone, joined) with
// actions Change plan · Extend trial/period · Suspend ↔ Reactivate · Impersonate (each per permission). Quick stats
// (PHASE-8-2 §7.1, `view_merchants`): MRR 33:5043, Orders · 30d 33:5047, GMV · 30d 33:5051, Lifetime paid 33:5055;
// Health score 33:5059 hidden (Q105). Overview gains "GMV & platform revenue" 33:5128 after Usage. Past-due banner without Send reminder / Retry now. Tabs Overview / Billing / Domains / Staff · N
// / Audit log (Orders, Integrations, Notes hidden).
export function MerchantDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (['overview', 'billing', 'domains', 'staff', 'audit'].includes(params.get('tab') ?? '') ? params.get('tab') : 'overview') as TabKey;
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogKey>(null);
  const tenant = useQuery({
    queryKey: ['admin', 'tenant', id],
    queryFn: () => api.admin.tenants.get(id),
  });
  const metrics = useQuery({
    queryKey: ['admin', 'tenant', id, 'metrics'],
    queryFn: () => api.admin.tenantMetrics(id),
    enabled: tenant.isSuccess,
  });

  const setTab = (t: TabKey) => {
    const next = new URLSearchParams(params);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    next.delete('invoice');
    setParams(next, { replace: true });
  };

  const refresh = (updated?: AdminTenant) => {
    if (updated) queryClient.setQueryData(['admin', 'tenant', id], updated);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
  };

  if (tenant.isPending) {
    return (
      <div role="status" aria-label="Loading merchant" className="flex flex-col gap-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-64 w-full rounded-card" />
      </div>
    );
  }
  if (tenant.isError) {
    return (
      <>
        <Breadcrumb name="Merchant" />
        <Card>
          <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} title="We couldn’t load this merchant" />
        </Card>
      </>
    );
  }

  const t = tenant.data;
  const suspended = t.status === 'suspended';
  const status = tenantStatus(t);
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {can('manage_billing') && (
        <>
          <Button variant="secondary" onClick={() => setDialog('plan')}>
            Change plan
          </Button>
          {t.subscription && (
            <Button variant="secondary" onClick={() => setDialog('extend')}>
              {extendLabel(t)}
            </Button>
          )}
        </>
      )}
      {can('suspend') &&
        (suspended ? (
          <Button variant="secondary" onClick={() => setDialog('reactivate')}>
            Reactivate
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setDialog('suspend')}>
            Suspend
          </Button>
        ))}
      {can('impersonate') && <Button onClick={() => setDialog('impersonate')}>Impersonate</Button>}
    </div>
  );

  return (
    <>
      <Breadcrumb name={t.name} />
      <Card className="flex flex-col gap-5 px-6 py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 gap-4">
            <Avatar name={t.name} size="lg" className="rounded-lg" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-heading-24 text-text-primary">{t.name}</h1>
                <Badge size="sm" tone="brand">
                  {planName(t.plan_code)}
                </Badge>
                <Badge size="sm" tone={status.tone}>
                  {status.label}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-text-secondary">
                {t.store?.primary_host && (
                  <a
                    href={`https://${t.store.primary_host}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-brand-600 hover:underline"
                  >
                    <ExternalLink aria-hidden className="size-4" />
                    {t.store.primary_host}
                  </a>
                )}
                {t.owner && (
                  <span className="flex items-center gap-1.5">
                    <User aria-hidden className="size-4 text-text-muted" />
                    {t.owner.name} (owner) · {t.owner.email}
                  </span>
                )}
                {t.owner?.phone && (
                  <span className="flex items-center gap-1.5">
                    <Phone aria-hidden className="size-4 text-text-muted" />
                    {t.owner.phone}
                  </span>
                )}
              </div>
              <span className="flex items-center gap-1.5 text-caption text-text-muted">
                <Calendar aria-hidden className="size-3.5" /> Joined {formatDate(t.created_at)} · {t.store ? `store ${t.store.status}` : 'no store yet'}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-start gap-2 xl:items-end">
            {actions}
            {can('impersonate') && <p className="text-caption text-text-muted">Impersonation needs a reason and shows on the shop’s activity log.</p>}
          </div>
        </div>
        <MetricStats tenant={t} metrics={metrics} />
      </Card>

      {suspended && t.suspension && (
        <Banner
          tone="danger"
          icon={<ShieldAlert />}
          title={`Suspended ${formatDate(t.suspension.suspended_at)} · ${
            suspensionReasons.find((r) => r.code === t.suspension!.reason_code)?.label ?? t.suspension.reason_code
          }`}
        >
          Storefront shows “temporarily unavailable” and the merchant dashboard is locked. See the audit log for the reason.
        </Banner>
      )}
      {!suspended && t.subscription_status === 'past_due' && (
        <Banner tone="warning" icon={<AlertTriangle />} title="Payment past due">
          {t.open_invoice ? `${money(t.open_invoice.total_amount)} outstanding on ${t.open_invoice.number}` : 'The renewal is unpaid'}
          {t.subscription?.grace_ends_at ? ` · paid features stop after ${formatDate(t.subscription.grace_ends_at)}` : ''}
        </Banner>
      )}

      <Tabs
        aria-label="Merchant sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'billing', label: 'Billing' },
          { value: 'domains', label: 'Domains' },
          { value: 'staff', label: `Staff · ${t.member_count}` },
          { value: 'audit', label: 'Audit log' },
        ]}
      />
      {tab === 'overview' && <OverviewTab tenant={t} metrics={metrics} onTab={setTab} onChangePlan={can('manage_billing') ? () => setDialog('plan') : undefined} />}
      {tab === 'billing' && <BillingTab tenant={t} />}
      {tab === 'domains' && <DomainsTab tenantId={t.id} />}
      {tab === 'staff' && <StaffTab tenantId={t.id} />}
      {tab === 'audit' && <AuditTab tenantId={t.id} />}

      {dialog === 'plan' && (
        <ChangePlanDialog
          tenant={t}
          onClose={() => setDialog(null)}
          onDone={(s) => {
            setDialog(null);
            toast(s.scheduled_change ? `${s.scheduled_change.plan.name} starts at the next renewal` : `${t.name} is now on ${s.plan.name}`);
            refresh();
          }}
        />
      )}
      {dialog === 'extend' && (
        <ExtendDialog
          tenant={t}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            toast(`${extendLabel(t)} done`);
            refresh();
          }}
        />
      )}
      {dialog === 'suspend' && (
        <SuspendDialog
          tenant={t}
          onClose={() => setDialog(null)}
          onDone={(u) => {
            setDialog(null);
            toast(`${t.name} suspended`);
            refresh(u);
          }}
        />
      )}
      {dialog === 'reactivate' && (
        <ReactivateDialog
          tenant={t}
          onClose={() => setDialog(null)}
          onDone={(u) => {
            setDialog(null);
            toast(`${t.name} reactivated`);
            refresh(u);
          }}
        />
      )}
      {dialog === 'impersonate' && <ImpersonateDialog tenant={t} onClose={() => setDialog(null)} />}
    </>
  );
}

function Breadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body">
      <Link to="/merchants" className="font-medium text-brand-600 hover:underline">
        Merchants
      </Link>
      <ChevronRight aria-hidden className="size-4 text-text-muted" />
      <span className="truncate text-text-secondary">{name}</span>
    </nav>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-caption text-text-muted">{label}</span>
      <span className="truncate text-heading text-text-primary tabular-nums">{value}</span>
      <span className="truncate text-caption text-text-muted">{hint}</span>
    </div>
  );
}

function Banner({ tone, icon, title, children }: { tone: 'warning' | 'danger'; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div role="status" className={`flex gap-3 rounded-card px-5 py-4 ${tone === 'danger' ? 'bg-danger-bg' : 'bg-warning-bg'}`}>
      <span aria-hidden className={`mt-0.5 [&_svg]:size-5 ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}>
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        <span className="text-caption text-text-secondary">{children}</span>
      </span>
    </div>
  );
}

function SectionCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4">
        <div className="flex flex-col">
          <h2 className="text-body-lg font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="text-caption text-text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-body font-medium text-brand-600 hover:underline">
      {children}
    </button>
  );
}

type MetricsQuery = UseQueryResult<{ data: AdminTenantMetrics; meta: { as_of: string | null } }>;

/** "Starter · monthly" / "Comp · not billed" / "Trial" / "Free" (§7.1 Stat/MRR caption). */
function mrrCaption(t: AdminTenant, m: AdminTenantMetrics): string {
  if (m.is_comp) return 'Comp · not billed';
  if (t.subscription_status === 'trialing') return 'Trial';
  const plan = m.plan_code ?? t.plan_code;
  if (!plan || plan === 'free' || !m.mrr_amount) return 'Free';
  return `${planName(plan)} · ${m.billing_interval === 'year' ? 'yearly' : 'monthly'}`;
}

/** Quick stats row (4 columns): MRR, Orders · 30d, GMV · 30d, Lifetime paid. */
function MetricStats({ tenant: t, metrics }: { tenant: AdminTenant; metrics: MetricsQuery }) {
  const m = metrics.data?.data;
  const pending = metrics.isPending;
  const failed = metrics.isError;
  const value = (v: string) => (pending ? <Skeleton className="h-7 w-20" /> : failed ? '—' : v);
  const orders = m ? delta(m.orders_30d, m.previous_orders_30d, 'ratio') : null;
  const ordersHint = orders ? `${orders.label} vs previous 30 days` : 'Last 30 days';
  return (
    <div className="flex flex-col gap-2 border-t border-border-default pt-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="MRR" value={value(formatBdtCompact(m?.mrr_amount))} hint={m ? mrrCaption(t, m) : ' '} />
        <Stat label="Orders · 30d" value={value(formatCount(m?.orders_30d))} hint={m ? ordersHint : ' '} />
        <Stat label="GMV · 30d" value={value(formatBdtCompact(m?.gmv_30d_amount))} hint={m ? `AOV ${money(m.aov_30d_amount)}` : ' '} />
        <Stat label="Lifetime paid" value={money(t.lifetime_paid_amount)} hint="Sum of paid invoices" />
      </div>
      {failed && (
        <p role="alert" className="flex items-center gap-2 text-caption text-danger">
          We couldn’t load this shop’s metrics.
          <button type="button" onClick={() => void metrics.refetch()} className="font-medium text-brand-600 hover:underline">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/** GMV & platform revenue 33:5128: values 33:5135, 12 monthly bars 33:5145 (current month highlighted 33:5179). */
function GmvCard({ metrics }: { metrics: MetricsQuery }) {
  const m = metrics.data?.data;
  const change = m ? delta(m.gmv_30d_amount, m.previous_gmv_30d_amount, 'ratio') : null;
  const empty = !!m && (!metrics.data?.meta.as_of || m.monthly.every((x) => x.gmv_amount === null));
  return (
    <SectionCard title="GMV & platform revenue" subtitle="Last 12 months" action={<DeltaPill delta={change} />}>
      <div className="flex flex-col gap-4 px-5 pb-5">
        {metrics.isError ? (
          <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
        ) : metrics.isPending ? (
          <div role="status" aria-label="Loading GMV">
            <Skeleton className="h-44 w-full rounded-lg" />
          </div>
        ) : empty || !m ? (
          <NoAnalytics />
        ) : (
          <>
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Kv label="GMV this month" value={formatBdtCompact(m.gmv_month_amount)} />
              <Kv label="Paid to Storeplix (12 mo)" value={money(m.paid_12m_amount)} />
              <Kv label="Avg orders / day" value={m.avg_orders_per_day_30d === null ? '—' : m.avg_orders_per_day_30d.toLocaleString('en-IN', { maximumFractionDigits: 1 })} />
            </dl>
            <BarChart
              caption="GMV per month"
              axis={false}
              height={140}
              formatValue={(n) => formatBdtCompact(n)}
              bars={m.monthly.map((x, i) => ({
                label: monthShort(x.month),
                value: x.gmv_amount,
                note: 'No data',
                tone: i === m.monthly.length - 1 ? 'brand' : 'soft',
              }))}
            />
          </>
        )}
      </div>
    </SectionCard>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-heading text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}

function OverviewTab({
  tenant: t,
  metrics,
  onTab,
  onChangePlan,
}: {
  tenant: AdminTenant;
  metrics: MetricsQuery;
  onTab: (t: TabKey) => void;
  onChangePlan?: () => void;
}) {
  const invoices = useQuery({
    queryKey: ['admin', 'tenant', t.id, 'invoices', 'recent'],
    queryFn: () => api.admin.tenants.invoices(t.id, { per_page: 5 }),
  });
  const audit = useQuery({
    queryKey: ['admin', 'tenant', t.id, 'audit', 'recent'],
    queryFn: () => api.admin.tenants.auditLogs(t.id, { per_page: 5 }),
  });
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const sub = t.subscription;
  const usage = t.usage.filter((u) => u.key !== 'sms_per_month' && u.key !== 'ai_credits_per_month');

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-5">
        <SectionCard title="Usage vs plan limits" subtitle={`${planName(t.plan_code)} plan`}>
          {usage.length === 0 && (
            <p className="px-5 pb-3 text-caption text-text-muted">Limits appear once the shop has a subscription.</p>
          )}
          <ul className="flex flex-col gap-4 px-5 pb-5">
            {usage.map((u) => {
              const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
              return (
                <li key={u.key} className="flex flex-col gap-1.5">
                  <span className="flex justify-between gap-3 text-body">
                    <span className="text-text-primary">{usageLabels[u.key] ?? u.key}</span>
                    <span className="font-medium text-text-primary tabular-nums">
                      {formatCount(u.used)} / {u.limit === null ? 'Unlimited' : formatCount(u.limit)}
                    </span>
                  </span>
                  <ProgressBar value={u.limit === null ? 0 : pct / 100} label={usageLabels[u.key] ?? u.key} />
                  <span className={`text-caption ${pct >= 90 ? 'text-warning' : 'text-text-muted'}`}>
                    {u.limit === null ? `No limit on ${planName(t.plan_code)}` : `${pct}% used`}
                  </span>
                </li>
              );
            })}
            {/* PHASE-8-9A 33:5121: SMS credits row with "Adjust credits" (2095:9090). */}
            <SmsUsageRow tenant={t} />
            {/* PHASE-8-9D §10.4: AI credits row (allowance this month + bonus) with "Adjust AI credits". */}
            <AiUsageRow tenant={t} />
          </ul>
        </SectionCard>

        <GmvCard metrics={metrics} />

        <SectionCard
          title="Recent invoices"
          action={
            <LinkButton onClick={() => onTab('billing')}>
              All invoices <ArrowRight aria-hidden className="size-4" />
            </LinkButton>
          }
        >
          <InvoicesTable
            showShop={false}
            className="rounded-none border-x-0 border-b-0 shadow-none"
            rows={invoices.data?.data ?? []}
            onOpen={(i) => setInvoiceId(i.id)}
            state={
              invoices.isPending ? (
                <LoadingRows label="Loading invoices" rows={3} />
              ) : invoices.isError ? (
                <ErrorState error={invoices.error} onRetry={() => void invoices.refetch()} />
              ) : invoices.data.data.length === 0 ? (
                <Empty title="No invoices yet" description="This shop hasn’t been billed." />
              ) : undefined
            }
          />
        </SectionCard>

        <SectionCard
          title="Audit log"
          subtitle="Latest staff and merchant actions on this shop"
          action={
            <LinkButton onClick={() => onTab('audit')}>
              View all <ArrowRight aria-hidden className="size-4" />
            </LinkButton>
          }
        >
          <AuditTable
            showTenant={false}
            rows={audit.data?.data ?? []}
            state={
              audit.isPending ? (
                <LoadingRows label="Loading audit log" rows={3} />
              ) : audit.isError ? (
                <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
              ) : audit.data.data.length === 0 ? (
                <Empty icon={<ScrollText />} title="No events yet" />
              ) : undefined
            }
          />
        </SectionCard>
      </div>

      <SectionCard title="Subscription" action={onChangePlan && <LinkButton onClick={onChangePlan}>Change plan</LinkButton>}>
        {!sub ? (
          <Empty title="No subscription" description="The shop is on the Free plan without a subscription record." />
        ) : (
          <div className="flex flex-col gap-4 px-5 pb-5">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-brand-50 px-4 py-3.5">
              <span className="flex flex-col">
                <span className="text-body font-semibold text-text-primary">
                  {sub.plan.name} · {intervalLabel(sub.billing_interval).toLowerCase()}
                </span>
                <span className="text-caption text-text-secondary">Since {formatDate(sub.current_period_start ?? t.created_at)}</span>
              </span>
              <span className="text-heading text-brand-600">
                {money(sub.billing_interval === 'year' ? sub.plan.price_yearly_amount : sub.plan.price_amount)}
              </span>
            </div>
            <dl className="flex flex-col gap-2.5 text-body">
              <Fact label="Status" value={<TenantStatusBadge tenant={t} />} />
              {sub.status === 'trialing' && <Fact label="Trial ends" value={formatDate(sub.trial_ends_at)} />}
              {sub.current_period_end && <Fact label={sub.cancel_at_period_end ? 'Ends' : 'Renews'} value={formatDate(sub.current_period_end)} />}
              {sub.grace_ends_at && <Fact label="Grace ends" value={formatDate(sub.grace_ends_at)} />}
              {sub.scheduled_change && (
                <Fact label="Scheduled" value={`${sub.scheduled_change.plan.name} · ${formatDate(sub.scheduled_change.effective_at)}`} />
              )}
              <Fact label="Billing email" value={t.owner?.email ?? '—'} />
            </dl>
          </div>
        )}
      </SectionCard>
      {invoiceId && <InvoiceDrawer invoiceId={invoiceId} onClose={() => setInvoiceId(null)} />}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right text-text-primary">{value}</dd>
    </div>
  );
}

function BillingTab({ tenant }: { tenant: AdminTenant }) {
  const tenantId = tenant.id;
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<'all' | BillingInvoiceStatus>('all');
  const [page, setPage] = useState(1);
  const invoiceId = params.get('invoice');
  const filters = {
    status: status === 'all' ? undefined : status,
    page,
    per_page: 25,
  };
  const list = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'invoices', filters],
    queryFn: () => api.admin.tenants.invoices(tenantId, filters),
    placeholderData: keepPreviousData,
  });
  const setInvoice = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('invoice', id);
    else next.delete('invoice');
    setParams(next, { replace: true });
  };
  return (
    <div className="flex flex-col gap-5">
      {/* PHASE-8-9A §13.2: SMS credits card + ledger above the invoices. */}
      <SmsCreditsCard tenant={tenant} />
      {/* PHASE-8-9D §10.4: AI credits card + ledger. */}
      <AiCreditsCard tenant={tenant} />
      <Card className="overflow-hidden">
        <div className="px-5 pt-3">
          <Tabs
            aria-label="Invoice status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            items={[
              { value: 'all', label: 'All' },
              { value: 'open', label: 'Open' },
              { value: 'paid', label: 'Paid' },
              { value: 'void', label: 'Void' },
            ]}
          />
        </div>
        <InvoicesTable
          showShop={false}
          rows={list.data?.data ?? []}
          onOpen={(i) => setInvoice(i.id)}
          state={
            list.isPending ? (
              <LoadingRows label="Loading invoices" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.data.data.length === 0 ? (
              <Empty title="No invoices" description="Nothing in this tab." />
            ) : undefined
          }
          footer={
            list.data && list.data.meta.total > 0 ? (
              <Pagination
                page={list.data.meta.current_page}
                perPage={list.data.meta.per_page}
                total={list.data.meta.total}
                lastPage={list.data.meta.last_page}
                noun="invoices"
                onPage={setPage}
              />
            ) : undefined
          }
        />
        {invoiceId && <InvoiceDrawer invoiceId={invoiceId} onClose={() => setInvoice(null)} />}
      </Card>
    </div>
  );
}

function DomainsTab({ tenantId }: { tenantId: string }) {
  const domains = useQuery({
    queryKey: ['admin', 'domains', 'tenant', tenantId],
    queryFn: () => api.admin.tenants.domains(tenantId),
  });
  return (
    <DomainsTable
      showShop={false}
      rows={domains.data ?? []}
      state={
        domains.isPending ? (
          <LoadingRows label="Loading domains" />
        ) : domains.isError ? (
          <ErrorState error={domains.error} onRetry={() => void domains.refetch()} />
        ) : domains.data.length === 0 ? (
          <Empty icon={<Globe />} title="No domains" description="This shop only uses its platform address." />
        ) : undefined
      }
    />
  );
}

/** Fallback when an older API omits `role_name` (PHASE-8-3 §7.5: the tab shows the tenant's role name). */
const memberRole: Record<string, string> = { owner: 'Owner', admin: 'Manager', staff: 'Staff', custom: 'Custom role' };

function StaffTab({ tenantId }: { tenantId: string }) {
  const members = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'members'],
    queryFn: () => api.admin.tenants.members(tenantId),
  });
  const columns: DataTableColumn<AdminTenantMember>[] = [
    {
      key: 'name',
      header: 'Member',
      mobileLabel: false,
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={m.name ?? m.email} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-medium text-text-primary">{m.name ?? 'Invited'}</span>
            <span className="truncate text-caption text-text-muted">{m.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      width: 150,
      cell: (m) => <span className="text-body text-text-secondary">{m.phone ?? '—'}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      width: 100,
      cell: (m) => <span className="text-body text-text-primary">{m.role_name || memberRole[m.role] || m.role}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 100,
      cell: (m) => (
        <Badge size="sm" tone={m.status === 'active' ? 'success' : 'info'}>
          {m.status === 'active' ? 'Active' : 'Invited'}
        </Badge>
      ),
    },
    {
      key: 'joined',
      header: 'Joined',
      width: 120,
      cell: (m) => <span className="text-body text-text-secondary">{formatDate(m.joined_at)}</span>,
    },
  ];
  return (
    <DataTable
      label="Shop staff"
      columns={columns}
      rows={members.data ?? []}
      getRowId={(m) => m.id ?? `invite-${m.email}`}
      state={
        members.isPending ? (
          <LoadingRows label="Loading staff" />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => void members.refetch()} />
        ) : members.data.length === 0 ? (
          <Empty icon={<Users />} title="No members" />
        ) : undefined
      }
    />
  );
}

function AuditTab({ tenantId }: { tenantId: string }) {
  const [impersonation, setImpersonation] = useState(false);
  const pages = useCursorPages(`${tenantId}-${impersonation}`);
  const filters = { impersonation, cursor: pages.cursor, per_page: 50 };
  const list = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'audit', filters],
    queryFn: () => api.admin.tenants.auditLogs(tenantId, filters),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <p className="text-caption text-text-muted">Staff actions show to the merchant as “Store Plix support”.</p>
        <label className="flex items-center gap-2.5 text-body text-text-primary">
          <Toggle label="Impersonations only" checked={impersonation} onChange={setImpersonation} />
          Impersonations only
        </label>
      </div>
      <AuditTable
        showTenant={false}
        rows={list.data?.data ?? []}
        state={
          list.isPending ? (
            <LoadingRows label="Loading audit log" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.data.length === 0 ? (
            <Empty icon={<ScrollText />} title="No events" description="Nothing recorded for this filter." />
          ) : undefined
        }
        footer={
          list.data && (list.data.data.length > 0 || pages.page > 1) ? (
            <CursorFooter
              page={pages.page}
              count={list.data.data.length}
              hasNext={!!list.data.meta.next_cursor}
              onPrev={pages.prev}
              onNext={() => list.data.meta.next_cursor && pages.next(list.data.meta.next_cursor)}
            />
          ) : undefined
        }
      />
    </Card>
  );
}
