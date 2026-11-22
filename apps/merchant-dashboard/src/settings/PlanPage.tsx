import type { LimitKey, Plan } from '@storeplix/types';
import { Badge, Button, Card, cn, EmptyState, Spinner } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Check, Star } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { planName, trialDaysLeft, useFeatures } from '../plan/useFeatures';
import { SettingsCard } from './SettingsLayout';

const money = (minor: number) => `৳ ${(minor / 100).toLocaleString('en-IN')}`;
const limitLabel: Record<LimitKey, string> = {
  orders_per_month: 'Orders',
  staff_seats: 'Staff seats',
  products: 'Products',
  courier_connections: 'Courier connections',
  sms_per_month: 'Order SMS per month',
};
const featureLabel: Record<string, string> = {
  custom_domain: 'Your own domain',
  all_couriers: 'All couriers',
  bulk_courier_booking: 'Bulk courier booking',
  fake_order_guard: 'Fake order guard',
  sms_automation: 'SMS automation',
  custom_roles: 'Custom roles',
  multi_warehouse: 'Multiple warehouses',
  pos: 'POS',
  profit_reports: 'Profit reports',
  api_webhooks: 'API & webhooks',
};

function limitText(plan: Plan): string[] {
  const l = plan.limits;
  const n = (v: number | null, unit: string) => (v === null ? `Unlimited ${unit}` : `${v.toLocaleString('en-IN')} ${unit}`);
  return [n(l.orders_per_month, 'orders / month'), n(l.staff_seats, 'staff seats'), n(l.products, 'products'), l.courier_connections === null ? 'All courier connections' : n(l.courier_connections, 'courier connection')];
}

// Figma Settings → Plan & billing 60:16361: Current plan 65:17435, Usage this month 65:17455, Plans 65:17495
// (read-only; upgrade/payment are Phase 7). Data: /subscription, /features, /plans.
export function PlanPage() {
  const { activeTenant } = useAuth();
  const allowed = can.viewBilling(activeTenant?.role);
  const features = useFeatures();
  const subscription = useQuery({ queryKey: ['subscription', activeTenant?.id], queryFn: () => api.subscription.get(), enabled: allowed, retry: false });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.plans.list(), retry: false, staleTime: 3_600_000 });

  if (!allowed) return <EmptyState icon={<Star />} title="Plan & billing is for owners and managers" description="Ask your shop owner about your plan." />;
  if (features.isPending || subscription.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading plan" />
      </div>
    );
  }
  if (!subscription.data || !features.data) return <EmptyState icon={<Star />} title="Couldn’t load your plan" description="Please try again later." />;

  const sub = subscription.data;
  const days = sub.status === 'trialing' ? trialDaysLeft(sub.trial_ends_at) : null;

  return (
    <>
      <section aria-label="Current plan" className="flex flex-col gap-5 rounded-card border border-brand-700 bg-brand-600 p-7 shadow-elevation-1">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <span className="self-start rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700">{days !== null ? 'Free trial' : 'Current plan'}</span>
            <h2 className="text-heading-32 text-text-inverse">{sub.plan.name} plan</h2>
            <p className="text-body text-brand-100">
              {money(sub.plan.price_amount)} / {sub.plan.interval} · {limitText(sub.plan).join(', ')}
            </p>
          </div>
          <a href="#plans" className="rounded-md border border-border-default bg-surface-card px-4 py-2 text-body font-semibold text-text-primary">
            Compare plans
          </a>
        </div>
        {days !== null && (
          <p className="rounded-lg bg-brand-700 px-4 py-3 text-body font-semibold text-text-inverse">
            {days} {days === 1 ? 'day' : 'days'} left in your {sub.plan.name} trial.{' '}
            <span className="font-normal text-brand-100">When it ends you move to the Free plan — nothing is locked or deleted.</span>
          </p>
        )}
      </section>

      <SettingsCard title="Usage this month" description={sub.current_period_end ? `Resets on ${new Date(sub.current_period_end).toLocaleDateString()}.` : 'Live usage against your plan limits.'} className="gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          {(Object.keys(limitLabel) as LimitKey[]).map((k) => {
            const { limit, used } = features.data.limits[k];
            const ratio = limit ? used / limit : 0;
            return (
              <div key={k} className="flex flex-col gap-2.5 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-body font-medium text-text-secondary">{limitLabel[k]}</span>
                  <span className="text-body font-semibold text-text-primary">{limit === null ? `${used} · unlimited` : `${used} of ${limit}`}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                  <div className={cn('h-full rounded-full', ratio >= 0.75 ? 'bg-warning' : 'bg-brand-600')} style={{ width: `${Math.min(1, ratio) * 100}%` }} />
                </div>
                <span className="text-caption text-text-muted">{limit === null ? 'No limit on your plan' : `${Math.max(0, limit - used)} left`}</span>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard title="Plans" description="Every plan includes the storefront, COD, courier booking and gateway payments.">
        <div id="plans" className="grid gap-4 lg:grid-cols-3">
          {plans.data?.map((p) => {
            const current = p.code === sub.plan.code;
            const recommended = p.code === 'starter';
            return (
              <Card key={p.id} className={cn('flex flex-col gap-4 p-5 shadow-none', recommended && 'border-2 border-brand-600 bg-brand-50')}>
                <div className="flex items-center justify-between">
                  <span className="text-body-lg font-medium text-text-primary">{p.name}</span>
                  {current ? <Badge>Current</Badge> : recommended ? <Badge tone="brand">Recommended</Badge> : null}
                </div>
                <p className="flex items-baseline gap-1">
                  <span className="text-heading-24 text-text-primary">{money(p.price_amount)}</span>
                  <span className="text-body text-text-secondary">/ {p.interval}</span>
                </p>
                <ul className="flex flex-1 flex-col gap-2">
                  {[...limitText(p), ...p.features.map((f) => featureLabel[f] ?? f)].map((f) => (
                    <li key={f} className="flex items-start gap-2 text-body text-text-primary">
                      <Check aria-hidden className={cn('mt-0.5 size-4 shrink-0', recommended ? 'text-brand-600' : 'text-success')} /> {f}
                    </li>
                  ))}
                </ul>
                {current ? (
                  <Button variant="ghost" fullWidth disabled>
                    Current plan
                  </Button>
                ) : (
                  <Button variant={recommended ? 'primary' : 'secondary'} fullWidth disabled title="Online payments are coming soon">
                    Upgrade to {planName(p.code)} · coming soon
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      </SettingsCard>
    </>
  );
}
