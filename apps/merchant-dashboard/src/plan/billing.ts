import type { BillingInterval, FeatureAccess, LimitKey, Plan, Subscription } from '@storeplix/types';
import { formatBdt } from '@storeplix/ui';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can } from '../lib/permissions';

// Phase 7 §8.2–8.3 shared billing state: query keys, formatters and the pure rules the screens and banners use.

export const billingKeys = {
  subscription: (tenantId: string | null) => ['subscription', tenantId] as const,
  plans: ['plans'] as const,
  invoices: (tenantId: string | null, page: number) => ['billing', tenantId, 'invoices', page] as const,
  invoice: (tenantId: string | null, id: string) => ['billing', tenantId, 'invoice', id] as const,
  payment: (tenantId: string | null, id: string) => ['billing', tenantId, 'payment', id] as const,
  quote: (tenantId: string | null, code: string, interval: BillingInterval) => ['billing', tenantId, 'quote', code, interval] as const,
};

export function useSubscription() {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({
    queryKey: billingKeys.subscription(tenantId),
    queryFn: () => api.subscription.get(),
    enabled: !!tenantId && can.viewBilling(activeTenant?.role),
    retry: false,
    staleTime: 60_000,
  });
}

export function usePlans() {
  return useQuery({ queryKey: billingKeys.plans, queryFn: () => api.plans.list(), retry: false, staleTime: 3_600_000 });
}

/** A plan change touches limits everywhere (domains `can_add`, profit report gate, usage): refetch everything. */
export function invalidatePlanState(qc: QueryClient) {
  return qc.invalidateQueries();
}

export const money = (paisa: number | null | undefined) => formatBdt(paisa);

/** "1 Dec 2026" (Figma date style); `short` drops the year ("1 Dec"). */
export function formatDate(iso: string | null | undefined, { short = false }: { short?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }) });
}

export const intervalWord = (i: BillingInterval) => (i === 'year' ? 'year' : 'month');

/** Price of a plan for an interval; null when the plan has no such option (Free yearly). */
export function planPrice(plan: Plan, interval: BillingInterval): number | null {
  if (interval === 'month') return plan.price_amount;
  return plan.price_yearly_amount;
}

/** Plan rank by monthly price (the API ranks by `plans.sort`, which follows price in every seeded plan). */
export function rankOf(plans: Plan[], code: string): number {
  const sorted = [...plans].sort((a, b) => a.price_amount - b.price_amount);
  return sorted.findIndex((p) => p.code === code);
}

export type PlanAction = 'current' | 'scheduled' | 'subscribe' | 'upgrade' | 'switch' | 'none';

/** What the plan card offers (§8.2 Plans): mirrors the API classification table §3.3 for the label only. */
export function planAction(sub: Subscription, plans: Plan[], target: Plan, interval: BillingInterval): PlanAction {
  const targetInterval: BillingInterval = target.code === 'free' ? 'month' : interval;
  const sched = sub.scheduled_change;
  if (sched && sched.plan.code === target.code && (target.code === 'free' || sched.interval === targetInterval)) return 'scheduled';
  const trialing = sub.status === 'trialing';
  const currentIsFree = sub.plan.code === 'free';
  if (!trialing && sub.plan.code === target.code && (currentIsFree || sub.billing_interval === targetInterval)) return 'current';
  if (target.code === 'free') return trialing || currentIsFree ? 'none' : 'switch';
  if (trialing || currentIsFree) return 'subscribe';
  const cur = rankOf(plans, sub.plan.code);
  const next = rankOf(plans, target.code);
  if (next > cur) return 'upgrade';
  if (next < cur) return 'switch';
  return targetInterval === 'year' ? 'upgrade' : 'switch';
}

export const limitLabel: Record<LimitKey, string> = {
  orders_per_month: 'Orders',
  staff_seats: 'Staff seats',
  products: 'Products',
  courier_connections: 'Courier connections',
  sms_per_month: 'Order SMS this month',
  custom_domains: 'Custom domains',
};

const limitNoun: Record<LimitKey, string> = {
  orders_per_month: 'orders',
  staff_seats: 'staff seats',
  products: 'products',
  courier_connections: 'courier connections',
  sms_per_month: 'order SMS',
  custom_domains: 'custom domains',
};

export interface LimitWarning {
  key: LimitKey;
  used: number;
  limit: number;
  /** Projected local date the orders limit is reached ("24 Nov"), orders only. */
  reachOn: string | null;
}

/**
 * Limit warning 65:17445: the first limit at ≥ 80 % (orders first). For orders, a linear projection from the local
 * month days elapsed; omitted when fewer than 3 days have passed or the projection falls after the month end.
 */
export function limitWarning(features: FeatureAccess, now = new Date()): LimitWarning | null {
  const order: LimitKey[] = ['orders_per_month', 'products', 'staff_seats', 'courier_connections', 'custom_domains', 'sms_per_month'];
  for (const key of order) {
    const usage = features.limits[key] as FeatureAccess['limits'][LimitKey] | undefined;
    if (!usage || usage.limit === null || usage.limit <= 0) continue;
    if (usage.used / usage.limit < 0.8) continue;
    let reachOn: string | null = null;
    if (key === 'orders_per_month' && usage.used < usage.limit) {
      const day = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      if (day >= 3 && usage.used > 0) {
        const reachDay = Math.ceil((usage.limit / usage.used) * day);
        if (reachDay <= daysInMonth) reachOn = new Date(now.getFullYear(), now.getMonth(), reachDay).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      }
    }
    return { key, used: usage.used, limit: usage.limit, reachOn };
  }
  return null;
}

export function limitWarningText(w: LimitWarning): string {
  const base = `${w.used.toLocaleString('en-IN')} of ${w.limit.toLocaleString('en-IN')} ${limitNoun[w.key]} used`;
  if (w.used >= w.limit) return `${base} — you’ve reached your plan’s limit.`;
  return w.reachOn ? `${base} — at this pace you’ll reach the limit around ${w.reachOn}.` : `${base}.`;
}

/** Q34 copy: storefront orders are never refused; manual orders are. */
export function limitWarningHint(w: LimitWarning): string {
  if (w.key === 'orders_per_month') return 'Shoppers can still order; you can’t add orders by hand until you upgrade or the month resets.';
  return 'Everything you already have keeps working; you can’t add more until you upgrade.';
}

/** The cheapest paid plan above the current one (for "Upgrade to Starter · ৳ 499/mo"). */
export function nextPlan(plans: Plan[], currentCode: string): Plan | null {
  const sorted = [...plans].sort((a, b) => a.price_amount - b.price_amount);
  const i = sorted.findIndex((p) => p.code === currentCode);
  return sorted.slice(i + 1).find((p) => p.price_amount > 0) ?? null;
}

/** Only a provider page may receive the browser: https, or the local fake page in dev (§8.2 Pay dialog). */
export function isSafeRedirect(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

export const providerLabel = { bkash: 'bKash', sslcommerz: 'Card, mobile banking (SSLCommerz)' } as const;

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
