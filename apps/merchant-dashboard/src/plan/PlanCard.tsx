import { ProgressBar } from '@storeplix/ui';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../lib/permissions';
import { planName, trialDaysLeft, useFeatures } from './useFeatures';

// Figma Sidebar 10:601 plan card: brand-50, 1px brand-100, rounded-lg, px 14 py 10, gap 6,
// Caption/12 Medium brand-700 · 6px progress · Caption/12 Medium brand-600 link.
export function PlanCard({ collapsed }: { collapsed?: boolean }) {
  const { activeTenant } = useAuth();
  const features = useFeatures().data;
  if (!features || collapsed) return null;
  const days = features.subscription_status === 'trialing' ? trialDaysLeft(features.trial_ends_at) : null;
  const orders = features.limits.orders_per_month;
  const title =
    days !== null
      ? `${planName(features.plan_code)} trial · ${days} ${days === 1 ? 'day' : 'days'} left`
      : orders.limit !== null
        ? `${planName(features.plan_code)} plan · ${orders.used} of ${orders.limit} orders`
        : `${planName(features.plan_code)} plan`;
  const value = days !== null ? Math.max(0, 1 - days / 14) : orders.limit ? orders.used / orders.limit : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-brand-100 bg-brand-50 px-3.5 py-2.5">
      <span className="text-caption font-medium text-brand-700">{title}</span>
      <ProgressBar value={value} label="Plan usage" className="bg-brand-100" />
      {can.viewBilling(activeTenant?.role) && (
        <Link to="/settings/plan" className="text-caption font-medium text-brand-600 hover:text-brand-700">
          See plans & usage
        </Link>
      )}
    </div>
  );
}
