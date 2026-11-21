import { Clock, Phone } from 'lucide-react';
import { Link } from 'react-router';
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
