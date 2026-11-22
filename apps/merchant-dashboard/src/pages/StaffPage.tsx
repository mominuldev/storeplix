import type { AuditLog, StaffMember, TenantRole } from '@storeplix/types';
import { Avatar, Badge, Button, Card, cn, EmptyState, ProgressBar, Spinner } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Check, Mail, Shield, Users } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { can, permissionMatrix, roleDescription, roleLabel } from '../lib/permissions';
import { formatBdPhone } from '../lib/phone';
import { InviteStaffModal } from '../staff/InviteStaffModal';
import { MemberActions } from '../staff/MemberActions';

const rolePill: Record<TenantRole, string> = {
  owner: 'bg-brand-50 text-brand-700',
  admin: 'bg-info-bg text-info',
  staff: 'bg-surface-subtle text-text-secondary',
};

function RolePill({ role }: { role: TenantRole }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-caption font-medium', rolePill[role])}>{roleLabel[role]}</span>;
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days < 2) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const activityText: Record<string, string> = {
  'staff.invited': 'invited a team member',
  'staff.invitation_resent': 'resent an invitation',
  'staff.invitation_revoked': 'cancelled an invitation',
  'staff.joined': 'joined the team',
  'staff.role_changed': 'changed a team member’s role',
  'staff.removed': 'removed a team member',
  'staff.left': 'left the team',
};

function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        {subtitle && <p className="text-body text-text-secondary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// Figma Staff & roles 89:26676 · Main 60:15365 (Online now, Actions today, sign-in security and per-person
// toggles skipped per contract) · Invite modal 90:26879. Labels: owner → Owner, admin → Manager, staff → Staff.
export function StaffPage() {
  const { activeTenant } = useAuth();
  const role = activeTenant?.role;
  const manage = can.manageStaff(role);
  const [inviting, setInviting] = useState(false);

  const staff = useQuery({ queryKey: ['staff', activeTenant?.id], queryFn: () => api.staff.list(), enabled: manage, retry: false });
  const activity = useQuery({
    queryKey: ['audit', 'staff', activeTenant?.id],
    queryFn: () => api.auditLogs.list({ action: 'staff.*', per_page: 5 }),
    enabled: can.viewAuditLog(role),
    retry: false,
  });

  if (!manage) {
    return (
      <>
        <PageHeader title="Staff" subtitle="Everyone who helps run your shop." />
        <Card>
          <EmptyState icon={<Shield />} title="Only the owner and managers can manage staff" description="Ask your shop owner if you need someone added or your role changed." />
        </Card>
      </>
    );
  }

  const members = staff.data?.data ?? [];
  const seats = staff.data?.meta;
  const active = members.filter((m) => m.kind === 'member');
  const invited = members.filter((m) => m.kind === 'invitation');
  const seatsText = seats ? (seats.seats_limit === null ? `${seats.seats_used} seats used · unlimited` : `${seats.seats_used} of ${seats.seats_limit} staff seats used`) : '';
  const countByRole = (r: TenantRole) => active.filter((m) => m.role === r).length;

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle={`Everyone who helps run ${activeTenant?.name ?? 'your shop'} — what they can see and do.`}
        actions={
          <>
            <Button onClick={() => setInviting(true)}>+ Invite staff</Button>
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Team summary">
        {[
          { dot: 'bg-brand-600', label: 'Team members', value: members.length || '—', note: `${active.length} active · ${invited.length} invited` },
          {
            dot: 'bg-info',
            label: 'Seats used',
            value: seats ? (seats.seats_limit === null ? seats.seats_used : `${seats.seats_used} of ${seats.seats_limit}`) : '—',
            note: seats?.seats_limit != null ? `${Math.max(0, seats.seats_limit - seats.seats_used)} seats left` : 'Owner doesn’t use a seat',
          },
        ].map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5 rounded-card border border-border-default bg-surface-card px-5 py-4 shadow-elevation-1">
            <span className="flex items-center gap-2 text-body text-text-secondary">
              <span className={cn('size-2 rounded-full', s.dot)} /> {s.label}
            </span>
            <span className="text-heading-24 text-text-primary">{s.value}</span>
            <span className="text-caption text-text-muted">{s.note}</span>
          </div>
        ))}
      </section>

      <div className="flex flex-col gap-6 xl:flex-row">
        <Card className="flex min-w-0 flex-1 flex-col gap-4 p-6">
          <SectionTitle title="Team" subtitle={`${members.length} people · ${seatsText}`} />
          {seats && seats.seats_limit !== null && <ProgressBar value={seats.seats_used / seats.seats_limit} label="Seats used" className="h-1.5 rounded-full" />}
          {staff.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner label="Loading team" />
            </div>
          ) : staff.isError ? (
            <EmptyState icon={<Users />} title="Couldn’t load your team" description={staff.error.message} />
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-border-default">
              <table className="w-full min-w-[560px] text-left">
                <thead className="bg-surface-subtle text-caption font-medium text-text-muted uppercase">
                  <tr>
                    <th className="py-2.5 pl-4 font-medium">Member</th>
                    <th className="w-[112px] py-2.5 pl-3 font-medium">Role</th>
                    <th className="w-[102px] py-2.5 pl-3 font-medium">Joined</th>
                    <th className="w-[96px] py-2.5 pl-3 font-medium">Status</th>
                    <th className="w-[60px] py-2.5 pr-4 pl-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <MemberRow key={`${m.kind}-${m.id}`} member={m} viewerRole={role} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {invited.filter((m) => m.status === 'invited').slice(0, 1).map((m) => (
            <p key={m.id} className="flex flex-wrap items-center gap-2.5 rounded-lg bg-warning-bg px-3.5 py-2.5 text-body text-text-primary">
              <Mail aria-hidden className="size-4 text-warning" />
              <span className="flex-1">
                {m.name ?? m.email} hasn’t accepted yet — invite link sent by email to {m.email}.
              </span>
            </p>
          ))}
        </Card>

        <Card className="flex w-full flex-col gap-3 p-5 xl:w-[340px]">
          <h2 className="text-body-lg font-medium text-text-primary">Roles</h2>
          {(['owner', 'admin', 'staff'] as const).map((r) => (
            <div key={r} className="flex flex-col gap-0.5 rounded-lg border border-border-default px-3 py-2.5">
              <span className="flex items-center gap-1.5">
                <RolePill role={r} />
                <span className="text-caption text-text-muted">
                  {countByRole(r)} {countByRole(r) === 1 ? 'person' : 'people'}
                </span>
              </span>
              <span className="text-caption text-text-secondary">{roleDescription[r]}</span>
            </div>
          ))}
          <p className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-caption text-text-primary">
            <Shield aria-hidden className="size-4 shrink-0 text-warning" />
            Custom roles like Order staff and Packer arrive in a later update.
          </p>
        </Card>
      </div>

      <Card className="flex flex-col gap-4 p-6">
        <SectionTitle title="Roles & permissions" subtitle="What each role can do. Owner always has full access." />
        <div className="relative overflow-x-auto rounded-lg border border-border-default">
          <table className="w-full min-w-[520px] text-left">
            <thead className="bg-surface-subtle text-caption font-medium text-text-muted uppercase">
              <tr>
                <th className="py-2.5 pl-4 font-medium">Permission</th>
                {(['owner', 'admin', 'staff'] as const).map((r) => (
                  <th key={r} className={cn('py-2.5 pl-4 text-center font-medium', r === 'staff' ? 'w-32 pr-4' : 'w-28')}>
                    {roleLabel[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissionMatrix.map((p) => (
                <tr key={p.label} className="border-t border-border-default">
                  <td className="py-3 pl-4">
                    <span className="block text-body font-medium text-text-primary">{p.label}</span>
                    {p.hint && <span className="mt-0.5 block text-caption text-text-secondary">{p.hint}</span>}
                  </td>
                  {(['owner', 'admin', 'staff'] as const).map((r) => (
                    <td key={r} className={cn('py-3 pl-4 text-center', r === 'staff' && 'pr-4')}>
                      <span
                        role="img"
                        aria-label={p[r] ? `${roleLabel[r]}: allowed` : `${roleLabel[r]}: not allowed`}
                        className={cn(
                          'inline-flex size-5 items-center justify-center rounded-sm align-middle',
                          p[r] ? 'bg-brand-600 text-text-inverse' : 'border-[1.5px] border-border-strong bg-surface-card',
                          r === 'owner' && 'opacity-50',
                        )}
                      >
                        {p[r] && <Check aria-hidden className="size-3.5" />}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="flex flex-col gap-1 p-6">
        <SectionTitle title="Recent staff activity" subtitle="Every important action is logged with who did it and when." />
        {activity.data?.data.length ? (
          <ul>
            {activity.data.data.map((a: AuditLog, i) => (
              <li key={a.id} className={cn('flex items-center gap-3 py-3', i > 0 && 'border-t border-border-default')}>
                <Avatar name={a.actor?.name ?? 'System'} size="sm" />
                <span className="flex-1 text-body text-text-secondary">
                  <strong className="font-semibold text-text-primary">{a.actor?.name ?? 'Storeplix'}</strong> {activityText[a.action] ?? a.action}
                </span>
                <span className="text-caption text-text-muted">{relative(a.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-body text-text-muted">{activity.isPending ? 'Loading…' : 'No staff activity yet.'}</p>
        )}
      </Card>

      <InviteStaffModal open={inviting} onClose={() => setInviting(false)} seats={seats} />
    </>
  );
}

function MemberRow({ member: m, viewerRole }: { member: StaffMember; viewerRole: TenantRole | undefined }) {
  const name = m.name ?? m.email;
  return (
    <tr className="border-t border-border-default">
      <td className="py-3 pl-4">
        <span className="flex items-center gap-3">
          <Avatar name={name} className={m.kind === 'invitation' ? 'bg-surface-subtle text-text-muted' : undefined} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-body font-semibold text-text-primary">
              {name}
              {m.is_you && ' (you)'}
            </span>
            <span className="truncate text-caption text-text-secondary">{m.phone ? formatBdPhone(m.phone) : m.email}</span>
          </span>
        </span>
      </td>
      <td className="py-3 pl-3">
        <RolePill role={m.role} />
      </td>
      <td className="py-3 pl-3 text-caption text-text-secondary">{m.kind === 'member' ? relative(m.joined_at) : '—'}</td>
      <td className="py-3 pl-3">
        {m.status === 'active' ? (
          <Badge tone="success" dot>
            Active
          </Badge>
        ) : m.status === 'invited' ? (
          <Badge tone="warning" dot>
            Invited
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Expired
          </Badge>
        )}
      </td>
      <td className="py-3 pr-4 pl-3">
        <MemberActions member={m} viewerRole={viewerRole} />
      </td>
    </tr>
  );
}
