import { isApiError } from '@storeplix/api-client';
import type { FeatureAccess, FeatureKey, Subscription } from '@storeplix/types';
import { buttonVariants, cn, Dialog } from '@storeplix/ui';
import { AlertTriangle, Clock, Phone } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../lib/permissions';
import { formatDate, money, usePlans, useSubscription } from './billing';
import { planName, trialDaysLeft, useFeatures } from './useFeatures';

/** Trial countdown from GET /features (task 2.7). */
export function TrialBanner() {
  const { activeTenant } = useAuth();
  const features = useFeatures().data;
  if (!features || features.subscription_status !== 'trialing') return null;
  const days = trialDaysLeft(features.trial_ends_at);
  if (days === null) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-4 py-3 text-body text-brand-700">
      <Clock aria-hidden className="size-4" />
      <span className="flex-1">
        You’re on the <strong className="font-semibold">{planName(features.plan_code)} trial</strong> — {days} {days === 1 ? 'day' : 'days'} left. After that your shop
        moves to the Free plan; nothing gets locked.
      </span>
      {can.viewBilling(activeTenant) && (
        <Link to="/settings/plan" className="font-semibold text-brand-600 hover:text-brand-700">
          See plans
        </Link>
      )}
    </div>
  );
}

const bannerTone = {
  danger: 'bg-danger-bg',
  warning: 'bg-warning-bg',
  info: 'bg-info-bg',
} as const;

// Figma States · Banner 148:35383: status bg, radius 12, px 16 py 12, gap 10, 16px alert icon, Body/14 primary text,
// secondary sm button on the right.
function BillingBannerFrame({ tone, children, action }: { tone: keyof typeof bannerTone; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex flex-wrap items-center gap-2.5 rounded-lg px-4 py-3', bannerTone[tone])}>
      <AlertTriangle aria-hidden className={cn('size-4 shrink-0', tone === 'info' ? 'text-info' : tone === 'warning' ? 'text-warning' : 'text-text-primary')} />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">{children}</p>
      {action}
    </div>
  );
}

const lostFeatureLabel: Partial<Record<FeatureKey, string>> = {
  custom_domain: 'your custom domain',
  bulk_courier_booking: 'bulk courier booking',
  profit_reports: 'profit reports',
  fake_order_guard: 'the fake order guard',
  purchasing: 'suppliers and purchase orders',
  sms_automation: 'SMS automation',
};

export type BillingBannerKind = 'past_due' | 'domain' | 'renewal' | 'trial' | null;

/** §8.3: one banner at a time, past_due > domain > renewal > trial. */
export function billingBannerKind(sub: Subscription | undefined, features: FeatureAccess | undefined, now = Date.now()): BillingBannerKind {
  if (sub?.status === 'past_due') return 'past_due';
  const domainGrace = sub?.domain_grace_ends_at ?? features?.domain_grace_ends_at ?? null;
  if (domainGrace) return 'domain';
  const inv = sub?.open_invoice;
  if (inv && inv.kind === 'renewal' && inv.status === 'open' && Date.parse(inv.due_at) - now <= 7 * 86_400_000) return 'renewal';
  if ((sub?.status ?? features?.subscription_status) === 'trialing') return 'trial';
  return null;
}

/** App-wide billing banner (O A only; staff see the trial banner at most, never billing state). */
export function PlanBanner() {
  const { activeTenant } = useAuth();
  const features = useFeatures().data;
  const sub = useSubscription().data;
  const plans = usePlans().data;
  const billing = can.viewBilling(activeTenant);
  const owner = can.manageBilling(activeTenant);
  if (!billing) return <TrialBanner />;
  const kind = billingBannerKind(sub, features);
  const payNow = owner ? (
    <Link to="/settings/plan?pay=1" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'shrink-0' })}>
      Pay now
    </Link>
  ) : (
    <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'shrink-0' })}>
      View plan
    </Link>
  );
  if (kind === 'past_due' && sub) {
    const free = plans?.find((p) => p.code === 'free');
    const lost = sub.plan.features.find((f) => !free?.features.includes(f) && lostFeatureLabel[f]);
    const keep = lost ? lostFeatureLabel[lost] : `your ${sub.plan.name} features`;
    return (
      <BillingBannerFrame tone="danger" action={payNow}>
        Payment failed for your {sub.plan.name} plan. Pay by {formatDate(sub.grace_ends_at, { short: true })} to keep {keep}.
      </BillingBannerFrame>
    );
  }
  if (kind === 'domain') {
    const date = sub?.domain_grace_ends_at ?? features?.domain_grace_ends_at ?? null;
    return (
      <BillingBannerFrame
        tone="warning"
        action={
          <Link to="/settings/plan#plans" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'shrink-0' })}>
            {owner ? 'Upgrade' : 'View plan'}
          </Link>
        }
      >
        Your custom domain stops working on {formatDate(date, { short: true })}. Upgrade to keep it.
      </BillingBannerFrame>
    );
  }
  if (kind === 'renewal' && sub?.open_invoice) {
    return (
      <BillingBannerFrame tone="info" action={payNow}>
        Your {sub.plan.name} plan renews on {formatDate(sub.open_invoice.due_at, { short: true })} · {money(sub.open_invoice.total_amount)}
      </BillingBannerFrame>
    );
  }
  if (kind === 'trial') return <TrialBanner />;
  return null;
}

/** Addendum A: unverified phone doesn't block the dashboard, but nags. */
export function VerifyPhoneBanner() {
  const { user } = useAuth();
  if (!user || user.phone_verified_at) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
      <Phone aria-hidden className="size-4 text-warning" />
      <span className="flex-1">Verify your mobile number so you can sign in with an SMS code and recover your account.</span>
      <Link to="/verify-phone" className="font-semibold text-brand-600 hover:text-brand-700">
        Verify now
      </Link>
    </div>
  );
}

// Phase 4 §9.2 / Phase 7 §8.3: any 402 `plan_limit_reached` opens one app-wide dialog. The button names the plan from
// `details.upgrade_plan[0]` (P7-17), falling back to Starter; only the owner can upgrade.
// Phase 8.3 W-2: a `feature` variant for a feature the plan doesn't include (`feature_not_in_plan`, "+ Custom role"),
// titled by the feature, not "You’ve reached your plan’s limit" (that stays for count limits).
interface PlanLimitState {
  message: string;
  upgradePlan: string | null;
  variant: 'limit' | 'feature';
  title: string | null;
}
let planLimit: PlanLimitState | null = null;
const planListeners = new Set<() => void>();
const emitPlan = () => planListeners.forEach((l) => l());

export function showPlanLimit(message: string, upgradePlan: string | null = null, opts: { variant?: 'limit' | 'feature'; title?: string } = {}) {
  planLimit = { message, upgradePlan, variant: opts.variant ?? 'limit', title: opts.title ?? null };
  emitPlan();
}

/** The feature-gate variant: `title` names the feature, e.g. "Custom roles are on Growth". */
export function showFeatureUpgrade(title: string, message: string, upgradePlan: string | null = null) {
  showPlanLimit(message, upgradePlan, { variant: 'feature', title });
}

/** Opens the plan-limit dialog for a 402 `plan_limit_reached` (or `feature_not_in_plan`) error. Returns true when handled. */
export function handlePlanLimit(error: unknown): boolean {
  if (isApiError(error) && error.status === 402 && (error.code === 'plan_limit_reached' || error.code === 'feature_not_in_plan')) {
    const hint = (error.details as Record<string, unknown> | undefined)?.upgrade_plan;
    const upgradePlan = Array.isArray(hint) && typeof hint[0] === 'string' ? hint[0] : null;
    if (error.code === 'feature_not_in_plan') showPlanLimit(error.message, upgradePlan, { variant: 'feature' });
    else showPlanLimit(error.message || 'You’ve reached your plan’s limit.', upgradePlan);
    return true;
  }
  return false;
}

export function PlanLimitDialog() {
  const navigate = useNavigate();
  const { activeTenant } = useAuth();
  const state = useSyncExternalStore(
    (l) => {
      planListeners.add(l);
      return () => planListeners.delete(l);
    },
    () => planLimit,
  );
  const close = () => {
    planLimit = null;
    emitPlan();
  };
  const owner = can.manageBilling(activeTenant);
  const target = state?.upgradePlan ?? 'starter';
  const feature = state?.variant === 'feature';
  return (
    <Dialog
      open={!!state}
      title={state?.title ?? (feature ? `Available on the ${planName(target)} plan` : 'You’ve reached your plan’s limit')}
      description={`${state?.message ?? ''} ${
        owner
          ? feature
            ? 'Upgrade to use it — nothing you already have is hidden or deleted.'
            : 'Upgrade to add more — nothing you already have is hidden or deleted.'
          : 'Ask your shop owner to upgrade.'
      }`}
      confirmLabel={owner ? `Upgrade to ${planName(target)}` : 'OK'}
      cancelLabel={owner ? 'Not now' : null}
      onCancel={close}
      onConfirm={() => {
        close();
        if (owner) navigate(`/settings/plan?upgrade=${encodeURIComponent(target)}`);
      }}
    />
  );
}
