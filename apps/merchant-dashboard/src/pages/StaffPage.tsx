import type { AuditLog, Role, StaffMember } from '@storeplix/types';
import { Avatar, Badge, Button, Card, cn, EmptyState, ProgressBar, Spinner } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Mail, Shield } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock } from '../catalog/states';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { auditActivityText, auditActorName, mergeRecentActivity } from '../lib/audit';
import { can, roleNameOf } from '../lib/permissions';
import { formatBdPhone } from '../lib/phone';
import { InviteStaffModal } from '../staff/InviteStaffModal';
import { MemberActions } from '../staff/MemberActions';
import { PermissionMatrix } from '../staff/PermissionMatrix';
import { listNames, peopleCount, rolePillClass, useNewRole, useRoles } from '../staff/roles';

export function RolePill({ name, className }: { name: string; className: string }) {
  return <span className={cn('inline-flex shrink-0 rounded-full px-2 py-0.5 text-caption font-medium whitespace-nowrap', className)}>{name}</span>;
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days < 2) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

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

// Figma Staff & roles 89:26676 · Main 60:15365 (Online now, Actions today, sign-in security and Add seats skipped per
// contract) · Invite modal 90:26879. PHASE-8-3 §7.2: role names from the API, Roles card, editable matrix.
export function StaffPage() {
  const { activeTenant } = useAuth();
  const manage = can.manageStaff(activeTenant);
  const [inviting, setInviting] = useState(false);
  const newRole = useNewRole();

  const staff = useQuery({ queryKey: ['staff', activeTenant?.id], queryFn: () => api.staff.list(), enabled: manage, retry: false });
  const roles = useRoles(manage);
  const activity = useQuery({
    queryKey: ['audit', 'staff', activeTenant?.id],
    queryFn: () => api.auditLogs.list({ action: 'staff.*', per_page: 5 }),
    enabled: can.viewAuditLog(activeTenant),
    retry: false,
  });
  // P8-QA-1 / PHASE-8-1 §7.2: Store Plix support actions on this shop (billing, suspension, support sessions) show here too.
  const supportActivity = useQuery({
    queryKey: ['audit', 'platform', activeTenant?.id],
    queryFn: () => api.auditLogs.list({ actor_type: 'platform_user', per_page: 5 }),
    enabled: can.viewAuditLog(activeTenant),
    retry: false,
  });
  const recentActivity = mergeRecentActivity([activity.data?.data, supportActivity.data?.data], 5);

  if (!manage) {
    return (
      <>
        <PageHeader title="Staff" subtitle="Everyone who helps run your shop." />
        <Card>
          <EmptyState icon={<Shield />} title="You can’t manage staff" description="Ask your shop owner if you need someone added or your role changed." />
        </Card>
      </>
    );
  }

  const members = staff.data?.data ?? [];
  const seats = staff.data?.meta;
  const roleList = roles.data?.data;
  const meta = roles.data?.meta;
  const customEnabled = !!meta?.custom_roles_enabled;
  const active = members.filter((m) => m.kind === 'member');
  const invited = members.filter((m) => m.kind === 'invitation');
  const seatsText = seats ? (seats.seats_limit === null ? `${seats.seats_used} seats used · unlimited` : `${seats.seats_used} of ${seats.seats_limit} staff seats used`) : '';

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle={`Everyone who helps run ${activeTenant?.name ?? 'your shop'} — what they can see and do.`}
        actions={<Button onClick={() => setInviting(true)}>+ Invite staff</Button>}
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

      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <Card className="flex min-w-0 flex-1 flex-col gap-4 p-6">
          <SectionTitle title="Team" subtitle={`${members.length} people · ${seatsText}`} />
          {seats && seats.seats_limit !== null && <ProgressBar value={seats.seats_used / seats.seats_limit} label="Seats used" className="h-1.5 rounded-full" />}
          {staff.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner label="Loading team" />
            </div>
          ) : staff.isError ? (
            <ErrorBlock error={staff.error} title="Couldn’t load your team" onRetry={() => void staff.refetch()} />
          ) : (
            <div className="relative overflow-x-auto rounded-lg border border-border-default">
              <table className="w-full min-w-[560px] text-left">
                <thead className="bg-surface-subtle text-caption font-medium text-text-muted uppercase">
                  <tr>
                    <th className="py-2.5 pl-4 font-medium">Member</th>
                    <th className="w-[128px] py-2.5 pl-3 font-medium">Role</th>
                    <th className="w-[102px] py-2.5 pl-3 font-medium">Joined</th>
                    <th className="w-[96px] py-2.5 pl-3 font-medium">Status</th>
                    <th className="w-[60px] py-2.5 pr-4 pl-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <MemberRow key={`${m.kind}-${m.id}`} member={m} roles={roleList} customRolesEnabled={customEnabled} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {invited
            .filter((m) => m.status === 'invited')
            .slice(0, 1)
            .map((m) => (
              <p key={m.id} className="flex flex-wrap items-center gap-2.5 rounded-lg bg-warning-bg px-3.5 py-2.5 text-body text-text-primary">
                <Mail aria-hidden className="size-4 text-warning" />
                <span className="flex-1">
                  {m.name ?? m.email} hasn’t accepted yet — invite link sent by email to {m.email}.
                </span>
              </p>
            ))}
        </Card>

        <RolesCard roles={roleList} loading={roles.isPending} error={roles.isError ? roles.error : null} onRetry={() => void roles.refetch()} onNew={() => newRole(meta)} />
      </div>

      <PermissionMatrix roles={roleList} meta={meta} rolesLoading={roles.isPending} rolesError={roles.isError ? roles.error : null} onNew={() => newRole(meta)} onRetry={() => void roles.refetch()} />

      <Card className="flex flex-col gap-1 p-6">
        <SectionTitle title="Recent staff activity" subtitle="Every important action is logged with who did it and when." />
        {recentActivity.length ? (
          <ul>
            {recentActivity.map((a: AuditLog, i) => (
              <li key={a.id} className={cn('flex items-center gap-3 py-3', i > 0 && 'border-t border-border-default')}>
                <Avatar name={auditActorName(a)} size="sm" />
                <span className="flex-1 text-body text-text-secondary">
                  <strong className="font-semibold text-text-primary">{auditActorName(a)}</strong> {auditActivityText(a.action)}
                </span>
                <span className="text-caption text-text-muted">{relative(a.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-body text-text-muted">{activity.isPending || supportActivity.isPending ? 'Loading…' : 'No staff activity yet.'}</p>
        )}
      </Card>

      <InviteStaffModal open={inviting} onClose={() => setInviting(false)} seats={seats} roles={roleList} rolesLoading={roles.isPending} customRolesEnabled={customEnabled} />
    </>
  );
}

// Figma Card / Roles 89:26720 — w 340, p 20, gap 12; rows: 1px border, radius 12, px 12 py 10; pill + "N people",
// description Caption/12 text-secondary, member avatars (24px), chevron; warning note when a role hides cost.
function RolesCard({ roles, loading, error, onRetry, onNew }: { roles: Role[] | undefined; loading: boolean; error: unknown; onRetry: () => void; onNew: () => void }) {
  const noCost = (roles ?? []).filter((r) => !r.permissions.includes('costs.view')).map((r) => r.name);
  return (
    <Card className="flex w-full flex-col gap-3 p-5 xl:w-[340px]" aria-label="Roles">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-body-lg font-medium text-text-primary">Roles</h2>
        <Button size="sm" variant="ghost" onClick={onNew}>
          + Custom role
        </Button>
      </div>
      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading roles" />
        </div>
      ) : error ? (
        <ErrorBlock error={error} title="Couldn’t load roles" onRetry={onRetry} className="px-2 py-6" />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {(roles ?? []).map((r) => (
              <li key={r.id}>
                <Link
                  to={`/staff/roles/${r.id}`}
                  aria-label={`${r.name} role`}
                  className="flex items-center gap-2.5 rounded-lg border border-border-default px-3 py-2.5 outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <RolePill name={r.name} className={rolePillClass(r.key ?? 'custom', r.id, roles)} />
                      <span className="text-caption whitespace-nowrap text-text-muted">{peopleCount(r.members_count)}</span>
                    </span>
                    {r.description && <span className="text-caption text-text-secondary">{r.description}</span>}
                  </span>
                  {r.members_preview.length > 0 && (
                    <span className="flex shrink-0 -space-x-1.5" aria-hidden>
                      {r.members_preview.slice(0, 3).map((p) => (
                        <Avatar key={p.id} name={p.name} className="size-6 border-2 border-surface-card text-caption" />
                      ))}
                    </span>
                  )}
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
                </Link>
              </li>
            ))}
          </ul>
          {noCost.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-caption text-text-primary">
              <Shield aria-hidden className="size-4 shrink-0 text-warning" />
              {listNames(noCost)} never see cost price or profit.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function MemberRow({ member: m, roles, customRolesEnabled }: { member: StaffMember; roles: Role[] | undefined; customRolesEnabled: boolean }) {
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
        <RolePill name={roleNameOf(m)} className={rolePillClass(m.role, m.role_id, roles)} />
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
        <MemberActions member={m} roles={roles} customRolesEnabled={customRolesEnabled} />
      </td>
    </tr>
  );
}
