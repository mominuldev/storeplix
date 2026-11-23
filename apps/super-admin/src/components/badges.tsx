import type { AdminDomain, AdminTenantSummary, BillingInvoiceStatus, ImpersonationStatus, PlatformRole, PlatformStaff } from '@storeplix/types';
import { Badge, cn, type BadgeTone } from '@storeplix/ui';
import { roleLabel } from '../lib/permissions';

// Figma StatusPill 31:6633 (h 20, px 8, py 2, Caption/12 Medium) — tones from the merchants table 32:5527:
// Active success · Trial info · Past due warning · Suspended danger.
export function tenantStatus(t: Pick<AdminTenantSummary, 'status' | 'subscription_status'>): { label: string; tone: BadgeTone } {
  if (t.status === 'suspended') return { label: 'Suspended', tone: 'danger' };
  switch (t.subscription_status) {
    case 'past_due':
      return { label: 'Past due', tone: 'warning' };
    case 'trialing':
      return { label: 'Trial', tone: 'info' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
    default:
      return { label: 'Active', tone: 'success' };
  }
}

export function TenantStatusBadge({ tenant }: { tenant: Pick<AdminTenantSummary, 'status' | 'subscription_status'> }) {
  const s = tenantStatus(tenant);
  return (
    <Badge size="sm" tone={s.tone}>
      {s.label}
    </Badge>
  );
}

const invoiceMeta: Record<BillingInvoiceStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  void: { label: 'Void', tone: 'neutral' },
};

export function InvoiceStatusBadge({ status, overdue }: { status: BillingInvoiceStatus; overdue?: boolean }) {
  const m = overdue && status === 'open' ? { label: 'Overdue', tone: 'danger' as const } : invoiceMeta[status];
  return (
    <Badge size="sm" tone={m.tone}>
      {m.label}
    </Badge>
  );
}

const impersonationMeta: Record<ImpersonationStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'info' },
  active: { label: 'Active', tone: 'warning' },
  ended: { label: 'Ended', tone: 'neutral' },
  expired: { label: 'Not used', tone: 'neutral' },
};

export function ImpersonationStatusBadge({ status }: { status: ImpersonationStatus }) {
  const m = impersonationMeta[status];
  return (
    <Badge size="sm" tone={m.tone} dot={status === 'active'}>
      {m.label}
    </Badge>
  );
}

// Team & roles 39:12019 role tag: neutral pill with a 6px role-coloured dot.
const roleDot: Record<PlatformRole, string> = {
  super_admin: 'bg-brand-600',
  billing: 'bg-info',
  support: 'bg-accent-500',
  read_only: 'bg-text-muted',
};

export function RoleBadge({ role }: { role: PlatformRole }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-surface-subtle px-2 text-caption font-medium text-text-primary">
      <span aria-hidden className={cn('size-1.5 rounded-full', roleDot[role])} />
      {roleLabel[role]}
    </span>
  );
}

const staffMeta: Record<PlatformStaff['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  invited: { label: 'Invited', tone: 'info' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  locked: { label: 'Locked', tone: 'danger' },
};

export function StaffStatusBadge({ status }: { status: PlatformStaff['status'] }) {
  const m = staffMeta[status];
  return (
    <Badge size="sm" tone={m.tone}>
      {m.label}
    </Badge>
  );
}

/** DNS / SSL check cell (Domains & SSL 45:8156): Verified/Issued success, Pending/Waiting warning, Failed danger. */
export function CheckBadge({ ok, kind, status }: { ok: boolean | null; kind: 'dns' | 'ssl'; status: AdminDomain['status'] }) {
  if (status === 'suspended')
    return (
      <Badge size="sm" tone="neutral">
        —
      </Badge>
    );
  if (ok === true)
    return (
      <Badge size="sm" tone="success">
        {kind === 'dns' ? 'Verified' : 'Issued'}
      </Badge>
    );
  if (ok === false)
    return (
      <Badge size="sm" tone="danger">
        {kind === 'dns' ? 'Misconfigured' : 'Failed'}
      </Badge>
    );
  return (
    <Badge size="sm" tone={kind === 'dns' ? 'warning' : 'neutral'}>
      {kind === 'dns' ? 'Pending' : 'Waiting'}
    </Badge>
  );
}
