import type { BillingInterval, BillingInvoiceSummary, GatewayProvider, LimitKey, Plan, Subscription } from '@storeplix/types';
import { Badge, Button, Card, Chip, cn, EmptyState, ProviderLogo, Spinner } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { toast } from '../online-store/components/Toast';
import {
  billingKeys,
  formatDate,
  intervalWord,
  invalidatePlanState,
  limitLabel,
  limitWarning,
  limitWarningHint,
  limitWarningText,
  money,
  nextPlan,
  planAction,
  planPrice,
  usePlans,
  useSubscription,
} from '../plan/billing';
import { trialDaysLeft, useFeatures } from '../plan/useFeatures';
import { ChangePlanDialog } from './billing/ChangePlanDialog';
import { InvoicesCard } from './billing/InvoicesCard';
import { PayDialog } from './billing/PayDialog';
import { PaymentReturnBanner } from './billing/PaymentReturn';
import { SettingsCard } from './SettingsLayout';

const featureLabel: Record<string, string> = {
  custom_domain: 'Your own domain',
  all_couriers: 'All couriers',
  bulk_courier_booking: 'Bulk courier booking',
  fake_order_guard: 'Fake order guard',
  purchasing: 'Suppliers & purchase orders',
  sms_automation: 'SMS automation',
  custom_roles: 'Custom roles',
  multi_warehouse: 'Multiple warehouses',
  pos: 'POS',
  profit_reports: 'Profit reports',
  api_webhooks: 'API & webhooks',
};

// Figma Plan cards 65:17495 taglines.
const planTagline: Record<string, string> = {
  free: 'For trying Storeplix',
  starter: 'For growing Facebook shops',
  growth: 'For shops with a team & warehouse',
};

function limitText(plan: Plan): string[] {
  const l = plan.limits;
  const n = (v: number | null, unit: string) => (v === null ? `Unlimited ${unit}` : `${v.toLocaleString('en-IN')} ${unit}`);
  return [n(l.orders_per_month, 'orders / month'), n(l.staff_seats, 'staff seats'), n(l.products, 'products'), l.courier_connections === null ? 'All courier connections' : n(l.courier_connections, 'courier connection')];
}

type ChangeTarget = { plan: Plan; interval: BillingInterval };

/** `meta.providers` of the invoices list (shared cache with the Invoices card's first page). */
function useBillingProviders(enabled: boolean): GatewayProvider[] {
  const { tenantId } = useAuth();
  const q = useQuery({ queryKey: billingKeys.invoices(tenantId, 1), queryFn: () => api.billing.invoices({ page: 1, per_page: 10 }), enabled, retry: false });
  return q.data?.meta.providers ?? [];
}

// Figma Settings → Plan & billing 60:16361 (Content 60:16857): Current plan 65:17435 (+ Limit warning 65:17445),
// Usage this month 65:17455, Plans 65:17495 (Monthly / Yearly chips 65:17491 / 65:17493), Payment method 65:17602,
// Invoices 65:17616. Phase 7 §8.2. Owner changes the plan and pays; admin reads; staff gets the empty state.
export function PlanPage() {
  const { activeTenant, tenantId } = useAuth();
  const allowed = can.viewBilling(activeTenant);
  const owner = can.manageBilling(activeTenant);
  const features = useFeatures();
  const subscription = useSubscription();
  const plans = usePlans();
  const providers = useBillingProviders(allowed);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [interval, setInterval] = useState<BillingInterval>('month');
  const [change, setChange] = useState<ChangeTarget | null>(null);
  const [paying, setPaying] = useState<BillingInvoiceSummary | null>(null);
  const [ret, setRet] = useState<{ paymentId: string | null; error: boolean } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ pay?: boolean; upgrade?: string } | null>(null);

  // Read the return/deep-link params once per change (§8.2 Return; banners' "Pay now"; 402 dialog "Upgrade to X"),
  // then strip them from the URL.
  const paramsKey = params.toString();
  const [seenParams, setSeenParams] = useState<string | null>(null);
  if (paramsKey && paramsKey !== seenParams) {
    setSeenParams(paramsKey);
    const payment = params.get('payment');
    const paymentError = params.get('payment_error') === '1';
    const pay = params.get('pay') === '1';
    const upgrade = params.get('upgrade');
    if (payment || paymentError) setRet({ paymentId: payment, error: paymentError && !payment });
    if (pay || upgrade) setPendingAction({ pay, upgrade: upgrade ?? undefined });
  } else if (!paramsKey && seenParams) setSeenParams(null);
  useEffect(() => {
    if (paramsKey) setParams({}, { replace: true });
  }, [paramsKey, setParams]);

  const sub = subscription.data;
  if (pendingAction && sub && plans.data) {
    setPendingAction(null);
    if (owner && pendingAction.pay && sub.open_invoice?.can_pay) setPaying(sub.open_invoice);
    else if (owner && pendingAction.upgrade) {
      const target = plans.data.find((p) => p.code === pendingAction.upgrade);
      if (target && planAction(sub, plans.data, target, 'month') !== 'current') setChange({ plan: target, interval: 'month' });
    }
  }

  const keep = useMutation({
    mutationFn: () => api.billing.cancelScheduledChange(),
    onSuccess: async () => {
      await invalidatePlanState(qc);
      toast(`You’ll stay on ${sub?.plan.name ?? 'your plan'}.`);
    },
    onError: (e) => toast(errorMessage(e, 'We couldn’t keep your plan. Try again.'), 'error'),
  });

  const payInvoiceById = async (invoiceId: string) => {
    try {
      const inv = await qc.fetchQuery({ queryKey: billingKeys.invoice(tenantId, invoiceId), queryFn: () => api.billing.invoice(invoiceId) });
      if (inv.status === 'open' && inv.can_pay) setPaying(inv);
      else toast('This invoice is already closed. Choose a plan below to start again.', 'error');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  if (!allowed) return <EmptyState icon={<Star />} title="Plan & billing is for owners and managers" description="Ask your shop owner about your plan." />;
  if (features.isPending || subscription.isPending || plans.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading plan" />
      </div>
    );
  }
  if (!sub || !features.data) {
    return (
      <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
        <ErrorBlock error={subscription.error ?? features.error} title="We couldn’t load your plan" onRetry={() => void Promise.all([subscription.refetch(), features.refetch()])} />
      </section>
    );
  }

  const allPlans = [...(plans.data ?? [])].sort((a, b) => a.price_amount - b.price_amount);
  const yearlyOffered = allPlans.some((p) => p.price_yearly_amount !== null);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-text-primary">Plan & billing</h2>
        <p className="text-body text-text-secondary">
          Your Storeplix subscription, this month’s usage and invoices.
          {sub.current_period_start && sub.current_period_end && sub.plan.code === 'free' ? ` Billing month: ${formatDate(sub.current_period_start, { short: true })}–${formatDate(sub.current_period_end)}.` : ''}
        </p>
      </div>

      {ret && <PaymentReturnBanner paymentId={ret.paymentId} error={ret.error} onDismiss={() => setRet(null)} onPayAgain={(id) => void payInvoiceById(id)} />}

      <CurrentPlanCard
        sub={sub}
        plans={allPlans}
        features={features.data}
        owner={owner}
        keeping={keep.isPending}
        onKeep={() => keep.mutate()}
        onPay={(inv) => setPaying(inv)}
        onUpgrade={(p) => setChange({ plan: p, interval: 'month' })}
      />

      <UsageCard sub={sub} features={features.data} />

      <SettingsCard
        title="Plans"
        description="Every plan includes the storefront, COD, courier booking and gateway payments."
        action={
          yearlyOffered && (
            <div role="group" aria-label="Billing interval" className="flex gap-2">
              <Chip check={false} selected={interval === 'month'} onClick={() => setInterval('month')}>
                Monthly
              </Chip>
              <Chip check={false} selected={interval === 'year'} onClick={() => setInterval('year')}>
                Yearly · 2 months free
              </Chip>
            </div>
          )
        }
      >
        {!owner && <p className="-mt-2 text-body text-text-secondary">Only the shop owner can change the plan.</p>}
        <div id="plans" className="grid gap-4 lg:grid-cols-3">
          {allPlans.map((p) => (
            <PlanCardItem key={p.id} plan={p} sub={sub} plans={allPlans} interval={interval} owner={owner} onChoose={() => setChange({ plan: p, interval })} />
          ))}
        </div>
      </SettingsCard>

      {/* Figma Payment method 65:17602 — Q83: no saved method, no auto-pay; accepted methods only. */}
      <SettingsCard title="Payment method" description="Pay each invoice with bKash or card. Payments are confirmed by the gateway before your plan changes.">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default p-4">
          <ProviderLogo provider="bkash" size="md" />
          <ProviderLogo provider="sslcommerz" size="md" />
          <p className="min-w-[12rem] flex-1 text-caption text-text-secondary">bKash, or cards and mobile banking through SSLCommerz. You pay by hand when an invoice is due — nothing is charged automatically.</p>
        </div>
      </SettingsCard>

      <InvoicesCard onPay={(inv) => setPaying(inv)} />

      {change && (
        <ChangePlanDialog
          key={`${change.plan.code}-${change.interval}`}
          plan={change.plan}
          interval={change.interval}
          onClose={() => setChange(null)}
          onInvoice={(inv) => {
            setChange(null);
            setPaying(inv);
          }}
        />
      )}
      {paying && <PayDialog key={paying.id} invoice={paying} providers={providers} onClose={() => setPaying(null)} />}
    </>
  );
}

function CurrentPlanCard({
  sub,
  plans,
  features,
  owner,
  keeping,
  onKeep,
  onPay,
  onUpgrade,
}: {
  sub: Subscription;
  plans: Plan[];
  features: NonNullable<ReturnType<typeof useFeatures>['data']>;
  owner: boolean;
  keeping: boolean;
  onKeep: () => void;
  onPay: (inv: BillingInvoiceSummary) => void;
  onUpgrade: (p: Plan) => void;
}) {
  const days = sub.status === 'trialing' ? trialDaysLeft(sub.trial_ends_at) : null;
  const sched = sub.scheduled_change;
  const pastDue = sub.status === 'past_due';
  const tag = days !== null ? 'Free trial' : pastDue ? 'Past due' : sched?.plan.code === 'free' ? `Ends ${formatDate(sched.effective_at, { short: true })}` : 'Current plan';
  const price = sub.plan.code === 'free' ? sub.plan.price_amount : planPrice(sub.plan, sub.billing_interval) ?? sub.plan.price_amount;
  const interval = sub.plan.code === 'free' ? 'month' : sub.billing_interval;
  const warning = limitWarning(features);
  const upgrade = nextPlan(plans, sub.plan.code);
  const overdue = sub.open_invoice;

  return (
    <section aria-label="Current plan" className="flex flex-col gap-5 rounded-card border border-brand-700 bg-brand-600 p-5 shadow-elevation-1 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className={cn('self-start rounded-full px-2 py-0.5 text-caption font-medium', pastDue ? 'bg-danger-bg text-danger' : 'bg-brand-50 text-brand-700')}>{tag}</span>
          <h2 className="text-heading-32 text-text-inverse">{sub.plan.name} plan</h2>
          <p className="text-body text-brand-100">
            {money(price)} / {intervalWord(interval)} · {limitText(sub.plan).join(', ')}
          </p>
        </div>
        <a href="#plans" className="inline-flex min-h-10 shrink-0 items-center rounded-md border border-border-default bg-surface-card px-4 py-2 text-body font-semibold text-text-primary">
          Compare plans
        </a>
      </div>

      {pastDue && (
        <Strip
          title={`Payment failed${overdue ? ` — ${money(overdue.total_amount)} due` : ''}. Pay by ${formatDate(sub.grace_ends_at)} to keep your ${sub.plan.name} plan.`}
          hint="After that your shop moves to the Free plan. Nothing is deleted."
          action={
            owner &&
            overdue?.can_pay && (
              <Button size="sm" variant="secondary" onClick={() => onPay(overdue)}>
                Pay now
              </Button>
            )
          }
        />
      )}
      {!pastDue && days !== null && (
        <Strip title={`${days} ${days === 1 ? 'day' : 'days'} left in your ${sub.plan.name} trial.`} hint="When it ends you move to the Free plan — nothing is locked or deleted. Subscribe now and the unused trial days are added to your first period." />
      )}
      {!pastDue && sched && (
        <Strip
          title={`Switches to ${sched.plan.name}${sched.plan.code === 'free' ? '' : ` (${intervalWord(sched.interval)}ly)`} on ${formatDate(sched.effective_at)}.`}
          hint="You keep everything on your current plan until then."
          action={
            owner && (
              <Button size="sm" variant="secondary" loading={keeping} onClick={onKeep}>
                Keep {sub.plan.name}
              </Button>
            )
          }
        />
      )}
      {!pastDue && warning && (
        <Strip
          title={limitWarningText(warning)}
          hint={limitWarningHint(warning)}
          action={
            owner &&
            upgrade && (
              <Button size="sm" variant="secondary" onClick={() => onUpgrade(upgrade)}>
                Upgrade to {upgrade.name} · {money(upgrade.price_amount)}/mo
              </Button>
            )
          }
        />
      )}
    </section>
  );
}

// Limit warning 65:17445: brand-700, radius lg, px 16 py 12, gap 12, 18px alert, Body/14 Semibold inverse +
// Caption/12 brand-100, sm secondary button.
function Strip({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-700 px-4 py-3">
      <AlertTriangle aria-hidden className="size-[18px] shrink-0 text-text-inverse" />
      <p className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
        <span className="text-body font-semibold text-text-inverse">{title}</span>
        {hint && <span className="text-caption text-brand-100">{hint}</span>}
      </p>
      {action}
    </div>
  );
}

function UsageCard({ sub, features }: { sub: Subscription; features: NonNullable<ReturnType<typeof useFeatures>['data']> }) {
  return (
    <SettingsCard title="Usage this month" description={sub.current_period_end ? `Resets on ${formatDate(sub.current_period_end)}.` : 'Live usage against your plan limits.'} className="gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {(Object.keys(limitLabel) as LimitKey[]).map((k) => {
          // Optional for rolling deploys: an API without the key yet skips the row.
          const usage = features.limits[k] as (typeof features.limits)[LimitKey] | undefined;
          if (!usage) return null;
          const { limit, used } = usage;
          const ratio = limit ? used / limit : 0;
          const over = limit !== null && used > limit;
          return (
            <div key={k} className="flex flex-col gap-2.5 rounded-lg border border-border-default p-4">
              <div className="flex items-center gap-2">
                <span className="flex-1 text-body font-medium text-text-secondary">{limitLabel[k]}</span>
                <span className={cn('text-body font-semibold', over ? 'text-danger' : 'text-text-primary')}>{limit === null ? `${used} · unlimited` : `${used} of ${limit}`}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                <div className={cn('h-full rounded-full', over ? 'bg-danger' : ratio >= 0.75 ? 'bg-warning' : 'bg-brand-600')} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
              </div>
              <span className={cn('text-caption', over ? 'text-danger' : 'text-text-muted')}>
                {limit === null ? 'No limit on your plan' : over ? 'Over your plan: existing items keep working; you can’t add more' : `${Math.max(0, limit - used)} left`}
              </span>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}

function PlanCardItem({ plan, sub, plans, interval, owner, onChoose }: { plan: Plan; sub: Subscription; plans: Plan[]; interval: BillingInterval; owner: boolean; onChoose: () => void }) {
  const action = planAction(sub, plans, plan, interval);
  const recommended = plan.code === 'starter';
  const showInterval: BillingInterval = plan.code === 'free' || plan.price_yearly_amount === null ? 'month' : interval;
  const price = planPrice(plan, showInterval) ?? plan.price_amount;
  const label =
    action === 'current'
      ? 'Current plan'
      : action === 'scheduled'
        ? 'Scheduled'
        : action === 'upgrade'
          ? `Upgrade to ${plan.name}`
          : action === 'subscribe'
            ? `Subscribe to ${plan.name}`
            : action === 'switch'
              ? `Switch to ${plan.name}`
              : null;
  return (
    <Card className={cn('flex flex-col gap-4 p-5 shadow-none', recommended && 'border-2 border-brand-600 bg-brand-50')}>
      <div className="flex items-center justify-between">
        <span className="text-body-lg font-medium text-text-primary">{plan.name}</span>
        {action === 'current' ? <Badge>Current</Badge> : action === 'scheduled' ? <Badge tone="info">Scheduled</Badge> : sub.status === 'trialing' && sub.plan.code === plan.code ? <Badge tone="brand">Your trial</Badge> : recommended ? <Badge tone="brand">Recommended</Badge> : null}
      </div>
      <p className="flex items-end gap-1 whitespace-nowrap">
        <span className="text-heading-24 text-text-primary">{money(price)}</span>
        <span className="text-body text-text-secondary">/ {intervalWord(showInterval)}</span>
      </p>
      {planTagline[plan.code] && <p className="text-body text-text-secondary">{planTagline[plan.code]}</p>}
      <ul className="flex flex-1 flex-col gap-2">
        {[...limitText(plan), ...plan.features.map((f) => featureLabel[f] ?? f)].map((f) => (
          <li key={f} className="flex items-start gap-2 text-body text-text-primary">
            <Check aria-hidden className={cn('mt-0.5 size-4 shrink-0', recommended ? 'text-brand-600' : 'text-success')} /> {f}
          </li>
        ))}
      </ul>
      {label &&
        (action === 'current' || action === 'scheduled' ? (
          <Button variant="ghost" fullWidth disabled>
            {label}
          </Button>
        ) : (
          owner && (
            <Button variant={recommended ? 'primary' : 'secondary'} fullWidth onClick={onChoose}>
              {label}
            </Button>
          )
        ))}
    </Card>
  );
}
