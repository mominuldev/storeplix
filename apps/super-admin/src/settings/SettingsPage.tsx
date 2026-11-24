import type { PlatformSecuritySettings } from '@storeplix/types';
import { Badge, buttonVariants, Card, cn, Toggle } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Lock, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useCan } from '../lib/permissions';
import { ConfirmSecurityDialog } from './ConfirmSecurityDialog';
import { securityQueryKey } from './queryKeys';

const onOff = (v: boolean) => (v ? 'On' : 'Off');

// Amendment A1-6. Figma Platform / Settings – Domains & SSL 45:8156 is the only drawn settings screen; its Settings
// nav 45:8173 has a "Security" item (45:8190) but no Security frame, so this tab is composed from that frame:
// page header 45:8167 (title, subtitle, "View audit log"), 240px nav card (surface-card, border, radius 16, p 8,
// gap 2; items px 12 py 9 gap 10, 18px icon, Body/14 Medium text-secondary; active brand-50 + Body/14 Semibold
// brand-700 + 14px chevron), 20px gap, then a card like 45:8529 (header Body/16 Medium + Caption secondary; toggle
// row 45:8564: border, radius 12, px 16 py 14, gap 12, 36px icon tile radius 10, Body/14 Medium title + Caption muted
// text, StatusPill, Toggle; divider; footer 45:8586 Caption muted "Last changed by … · …"). Only the Security tab is
// built; General, Subscription billing, Domains & SSL, Messaging, Email, Maintenance and Legal stay hidden (8.1 §7.1).
export function SettingsPage() {
  const can = useCan();
  const allowed = can('manage_settings');

  return (
    <>
      <PageHeader
        title="Platform settings"
        subtitle="Global configuration for every Storeplix shop and staff account"
        actions={
          can('view_merchants') && (
            <Link to="/audit-log" className={buttonVariants({ variant: 'secondary' })}>
              View audit log
            </Link>
          )
        }
      />
      {allowed ? (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <SettingsNav />
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <SecurityCard />
          </div>
        </div>
      ) : (
        <Card>
          <Empty icon={<Lock />} title="You can’t open platform settings" description="Only super admins can change platform settings." />
        </Card>
      )}
    </>
  );
}

function SettingsNav() {
  return (
    <nav aria-label="Settings sections" className="flex w-full shrink-0 flex-col gap-0.5 rounded-card border border-border-default bg-surface-card p-2 shadow-elevation-1 lg:w-60">
      <span
        aria-current="page"
        className="flex items-center gap-2.5 rounded-md bg-brand-50 px-3 py-[9px] text-body font-semibold text-brand-700"
      >
        <Shield aria-hidden className="size-[18px] shrink-0" />
        <span className="flex-1 truncate">Security</span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0" />
      </span>
    </nav>
  );
}

function SecurityCard() {
  const { environment } = useAuth();
  const [target, setTarget] = useState<boolean | null>(null);
  const query = useQuery({
    queryKey: securityQueryKey,
    queryFn: () => api.admin.settings.getSecurity(),
  });

  return (
    <Card className="flex flex-col gap-5 px-6 py-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-body-lg font-medium text-text-primary">Staff sign-in</h2>
        <p className="text-caption text-text-secondary">How platform staff prove who they are when they sign in to Platform admin</p>
      </div>

      {query.isPending ? (
        <LoadingRows label="Loading security settings" rows={2} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <SecurityBody settings={query.data} environment={environment} onToggle={setTarget} />
      )}

      {target !== null && query.data && (
        <ConfirmSecurityDialog enable={target} environment={environment} onClose={() => setTarget(null)} />
      )}
    </Card>
  );
}

function SecurityBody({
  settings,
  environment,
  onToggle,
}: {
  settings: PlatformSecuritySettings;
  environment: string | null;
  onToggle: (next: boolean) => void;
}) {
  const on = settings.staff_two_factor_required;
  const Icon = on ? ShieldCheck : ShieldAlert;
  const changed =
    settings.updated_at && settings.updated_by
      ? `Last changed by ${settings.updated_by.name} · ${formatDateTime(settings.updated_at)}`
      : settings.updated_at
        ? `Last changed ${formatDateTime(settings.updated_at)}`
        : 'Never changed · the environment default applies';

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-default px-4 py-3.5 sm:flex-nowrap">
        <span
          aria-hidden
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-control [&_svg]:size-5', on ? 'bg-success-bg text-success' : 'bg-warning-bg text-warning')}
        >
          <Icon />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-body font-medium text-text-primary">
            Require two-step sign-in for platform staff
          </p>
          <p className="text-caption text-text-muted">
            {on
              ? 'Staff enter a code from their authenticator app after their password.'
              : 'Staff sign in with their password only. Staff who already set up an authenticator app aren’t asked for a code.'}
          </p>
          <p className="text-caption text-text-muted">
            Default for this environment{environment ? ` (${environment})` : ''}: {onOff(settings.environment_default)}
          </p>
        </div>
        <Badge size="sm" tone={settings.source === 'setting' ? 'info' : 'neutral'}>
          {settings.source === 'setting' ? 'Set by a super admin' : 'Environment default'}
        </Badge>
        <Toggle label="Require two-step sign-in for platform staff" checked={on} onChange={onToggle} />
      </div>
      <div aria-hidden className="h-px bg-border-default" />
      <p className="text-caption text-text-muted">{changed}</p>
    </>
  );
}
