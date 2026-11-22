import { isApiError } from '@storeplix/api-client';
import { Dialog } from '@storeplix/ui';
import { Clock, Phone } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../lib/permissions';
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
      {can.viewBilling(activeTenant?.role) && (
        <Link to="/settings/plan" className="font-semibold text-brand-600 hover:text-brand-700">
          See plans
        </Link>
      )}
    </div>
  );
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

// Phase 4 §9.2: any 402 `plan_limit_reached` opens one app-wide dialog with "Upgrade to Starter".
let planLimitMessage: string | null = null;
const planListeners = new Set<() => void>();
const emitPlan = () => planListeners.forEach((l) => l());

export function showPlanLimit(message: string) {
  planLimitMessage = message;
  emitPlan();
}

/** Opens the plan-limit dialog for a 402 `plan_limit_reached` error. Returns true when handled. */
export function handlePlanLimit(error: unknown): boolean {
  if (isApiError(error) && error.status === 402 && error.code === 'plan_limit_reached') {
    showPlanLimit(error.message || 'You’ve reached your plan’s limit.');
    return true;
  }
  return false;
}

export function PlanLimitDialog() {
  const navigate = useNavigate();
  const { activeTenant } = useAuth();
  const message = useSyncExternalStore(
    (l) => {
      planListeners.add(l);
      return () => planListeners.delete(l);
    },
    () => planLimitMessage,
  );
  const close = () => {
    planLimitMessage = null;
    emitPlan();
  };
  const billing = can.viewBilling(activeTenant?.role);
  return (
    <Dialog
      open={!!message}
      title="You’ve reached your plan’s limit"
      description={`${message ?? ''} ${billing ? 'Upgrade to add more — nothing you already have is hidden or deleted.' : 'Ask the shop owner to upgrade the plan.'}`}
      confirmLabel={billing ? 'Upgrade to Starter' : 'OK'}
      cancelLabel={billing ? 'Not now' : null}
      onCancel={close}
      onConfirm={() => {
        close();
        if (billing) navigate('/settings/plan');
      }}
    />
  );
}
