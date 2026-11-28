import { cn } from '@storeplix/ui';
import { AlertTriangle, Info } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { useCan } from '../../lib/permissions';
import { topAlert } from './format';
import { usePlatformSmsAlerts } from './queries';

// Shell banner (PHASE-8-9B §11): `manage_settings` only; alerts refetched on route change (stale 60 s); the most
// severe alert shows with "Open SMS provider" (hidden on the SMS provider page itself).
export function PlatformSmsBanner() {
  const can = useCan();
  const allowed = can('manage_settings');
  const { pathname } = useLocation();
  const alerts = usePlatformSmsAlerts(allowed);
  const { refetch, isStale } = alerts;
  useEffect(() => {
    if (allowed && isStale) void refetch();
    // Route change is the trigger; staleness keeps it to one call per minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const alert = allowed ? topAlert(alerts.data) : null;
  if (!alert) return null;
  const Icon = alert.severity === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={alert.severity === 'danger' ? 'alert' : 'status'}
      data-testid="platform-sms-banner"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default px-4 py-2.5 text-body lg:px-8',
        alert.severity === 'danger' && 'bg-danger-bg text-danger',
        alert.severity === 'warning' && 'bg-warning-bg text-warning',
        alert.severity === 'info' && 'bg-info-bg text-info',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="font-semibold">{alert.message}</span>
      {pathname !== '/settings/sms' && (
        <Link to="/settings/sms?tab=provider" className="rounded-sm font-medium text-brand-600 underline-offset-2 outline-none hover:underline focus-visible:shadow-focus">
          Open SMS provider
        </Link>
      )}
    </div>
  );
}
