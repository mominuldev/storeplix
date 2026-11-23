import type { PlatformRole, PlatformStaff, PlatformTeamMeta } from '@storeplix/types';
import {
  Avatar,
  Badge,
  Button,
  Card,
  cn,
  DataTable,
  Dialog,
  KpiTile,
  FloatingMenu,
  Select,
  Toggle,
  type DataTableColumn,
  type MenuEntry,
} from '@storeplix/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, KeyRound, MoreHorizontal, RotateCcw, Search, Shield, ShieldCheck, UserCog, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { RoleBadge, StaffStatusBadge } from '../components/badges';
import { PillTabs } from '../components/PillTabs';
import { ReasonDialog } from '../components/ReasonDialog';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';
import { permissionMeta, roleLabel, useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { useDebounced } from '../lib/useDebounced';
import { InviteDialog } from './InviteDialog';

type StatusTab = 'all' | 'active' | 'invited' | 'disabled';
type Action =
  | { kind: 'role'; staff: PlatformStaff }
  | { kind: 'disable' | 'enable' | 'reset'; staff: PlatformStaff }
  | { kind: 'revoke'; staff: PlatformStaff };

const ROLES: PlatformRole[] = ['super_admin', 'billing', 'support', 'read_only'];

// Team & roles 39:12019 (§7.1, P8-16): KPI tiles (members, 2FA coverage), staff table with tabs and search, read-only
// permission matrix (four fixed roles), security card read-only from `meta.security`. "Last active", Active sessions,
// New role, Save permissions and Export are hidden. Every write needs `manage_team`.
export function TeamPage() {
  const can = useCan();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<StatusTab>('all');
  const [role, setRole] = useState<'' | PlatformRole>('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [invite, setInvite] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const filters = {
    status: tab === 'all' ? undefined : tab,
    role: role || undefined,
    q: term || undefined,
  };
  const team = useQuery({
    queryKey: ['admin', 'team', filters],
    queryFn: () => api.admin.team.list(filters),
    placeholderData: keepPreviousData,
  });
  // The matrix and security block arrive with every list (keepPreviousData keeps them while filters change).
  const meta: PlatformTeamMeta | null = team.data?.meta ?? null;

  const manage = can('manage_team');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin', 'team'] });
  const rows = team.data?.data ?? [];
  const enrolled = rows.filter((r) => r.kind === 'user' && r.status === 'active' && r.totp_enrolled).length;
  const activeUsers = rows.filter((r) => r.kind === 'user' && r.status === 'active').length;

  const entries = (s: PlatformStaff): MenuEntry[] => {
    if (!manage) return [];
    if (s.kind === 'invitation')
      return [
        {
          key: 'revoke',
          label: 'Revoke invitation',
          icon: <X />,
          danger: true,
          onSelect: () => setAction({ kind: 'revoke', staff: s }),
        },
      ];
    if (s.id === user?.id) return [];
    return [
      {
        key: 'role',
        label: 'Change role',
        icon: <UserCog />,
        onSelect: () => setAction({ kind: 'role', staff: s }),
      },
      {
        key: 'reset',
        label: 'Reset 2FA',
        hint: 'They enrol again on next sign-in',
        icon: <KeyRound />,
        onSelect: () => setAction({ kind: 'reset', staff: s }),
      },
      s.status === 'disabled'
        ? {
            key: 'enable',
            label: 'Enable',
            icon: <RotateCcw />,
            onSelect: () => setAction({ kind: 'enable', staff: s }),
          }
        : {
            key: 'disable',
            label: 'Disable',
            hint: 'Signs them out of the admin app',
            icon: <Ban />,
            danger: true,
            onSelect: () => setAction({ kind: 'disable', staff: s }),
          },
    ];
  };

  const columns: DataTableColumn<PlatformStaff>[] = [
    {
      key: 'member',
      header: 'Member',
      mobileLabel: false,
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={s.name ?? s.email} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2 truncate text-body font-medium text-text-primary">
              {s.name ?? 'Invited'}
              {s.id === user?.id && s.kind === 'user' && (
                <Badge size="sm" tone="brand">
                  You
                </Badge>
              )}
            </span>
            <span className="truncate text-caption text-text-muted">{s.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 130,
      cell: (s) => <RoleBadge role={s.role} />,
    },
    {
      key: '2fa',
      header: '2FA',
      width: 150,
      cell: (s) =>
        s.kind === 'invitation' ? (
          <span className="text-body text-text-muted">After first sign-in</span>
        ) : s.totp_enrolled ? (
          <span className="flex items-center gap-1.5 text-body text-text-primary">
            <ShieldCheck aria-hidden className="size-4 text-success" /> Authenticator
          </span>
        ) : (
          <Badge size="sm" tone="warning">
            Not set up
          </Badge>
        ),
    },
    {
      key: 'since',
      header: 'Invited',
      width: 130,
      cell: (s) => (
        <span className="text-body text-text-secondary">
          {s.kind === 'invitation' && s.expires_at ? `Expires ${formatDate(s.expires_at)}` : formatDate(s.invited_at)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 90,
      cell: (s) => <StaffStatusBadge status={s.status} />,
    },
    {
      key: 'menu',
      header: <span className="sr-only">Actions</span>,
      width: 32,
      align: 'end',
      mobileLabel: false,
      cell: (s) => {
        const e = entries(s);
        return e.length ? <FloatingMenu label={`Actions for ${s.email}`} trigger={<MoreHorizontal aria-hidden className="size-5" />} entries={e} /> : null;
      },
    },
  ];

  const counts = meta?.counts;
  return (
    <>
      <PageHeader
        title="Team & roles"
        subtitle="Storeplix staff with access to Platform admin · every action is written to the audit log"
        actions={manage && <Button onClick={() => setInvite(true)}>Invite teammate</Button>}
      />
      <section aria-label="Team summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={<Users />}
          label="Team members"
          value={counts ? counts.all : '—'}
          hint={counts ? `${counts.active} active · ${counts.invited} invited` : undefined}
        />
        <KpiTile
          icon={<ShieldCheck />}
          label="2FA coverage"
          value={activeUsers ? `${Math.round((enrolled / activeUsers) * 100)}%` : '—'}
          hint={activeUsers ? `${enrolled} / ${activeUsers} active members enrolled` : undefined}
        />
      </section>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-4">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-body-lg font-semibold text-text-primary">Platform staff</h2>
            <p className="text-caption text-text-muted">2FA is required for every member</p>
          </div>
          <div className="flex-1" />
          {/* Figma 39:12019 card header: title · tabs · search · Role, one row (wraps when narrow). */}
          <PillTabs
            aria-label="Staff status"
            value={tab}
            onChange={setTab}
            items={(['all', 'active', 'invited', 'disabled'] as const).map((t) => ({
              value: t,
              label: t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1),
              count: counts ? counts[t] : null,
            }))}
          />
          <label className="flex h-10 w-full items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus sm:w-52">
            <Search aria-hidden className="size-4 text-text-muted" />
            <input
              type="search"
              aria-label="Name or email"
              placeholder="Name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
          </label>
          <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as '' | PlatformRole)} containerClassName="w-40" className="h-10">
            <option value="">Role: All</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                Role: {roleLabel[r]}
              </option>
            ))}
          </Select>
        </div>
        {/* Fixed columns take ~600 px; keep the Member column readable at 1024 px and scroll inside the card. */}
        <div className="relative overflow-x-auto">
          <DataTable
            label="Platform staff"
            className={cn('relative rounded-none border-0 shadow-none', rows.length > 0 && 'md:min-w-[780px]')}
            columns={columns}
            rows={rows}
            getRowId={(s) => `${s.kind}-${s.id}`}
            state={
              team.isPending ? (
                <LoadingRows label="Loading staff" />
              ) : team.isError ? (
                <ErrorState error={team.error} onRetry={() => void team.refetch()} />
              ) : rows.length === 0 ? (
                <Empty icon={<Users />} title="No staff match these filters" description="Try another tab, role or search." />
              ) : undefined
            }
          />
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-col gap-1 px-5 pt-5 pb-4">
            <h2 className="text-body-lg font-semibold text-text-primary">Roles & permissions</h2>
            <p className="text-caption text-text-muted">What each platform role can do · fixed in this release</p>
          </div>
          {!meta ? (
            team.isError ? (
              <ErrorState error={team.error} onRetry={() => void team.refetch()} />
            ) : (
              <LoadingRows label="Loading roles" rows={4} />
            )
          ) : (
            <div className="overflow-x-auto px-5 pb-5">
              <table className="w-full min-w-[560px] overflow-hidden rounded-lg border border-border-default text-left">
                <caption className="sr-only">Permission matrix</caption>
                <thead className="bg-surface-subtle">
                  <tr>
                    <th scope="col" className="px-4 py-3 text-caption font-medium text-text-muted uppercase">
                      Permission
                    </th>
                    {meta.matrix.roles.map((r) => (
                      <th key={r} scope="col" className="px-2 py-3 text-center text-caption font-medium text-text-primary">
                        {roleLabel[r]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {meta.matrix.permissions.map((p) => (
                    <tr key={p} className="border-t border-border-default">
                      <th scope="row" className="px-4 py-3 text-left font-normal">
                        <span className="block text-body font-medium text-text-primary">{permissionMeta[p].label}</span>
                        <span className="block text-caption text-text-muted">{permissionMeta[p].hint}</span>
                      </th>
                      {meta.matrix.roles.map((r) => {
                        const granted = !!meta.matrix.grants[r]?.includes(p);
                        return (
                          <td key={r} className="px-2 py-3 text-center">
                            <span
                              role="img"
                              aria-label={`${roleLabel[r]}: ${granted ? 'allowed' : 'not allowed'}`}
                              className={
                                granted
                                  ? 'inline-flex size-5 items-center justify-center rounded-sm bg-brand-600 text-text-inverse'
                                  : 'inline-flex size-5 rounded-sm border-[1.5px] border-border-strong'
                              }
                            >
                              {granted && <Check aria-hidden strokeWidth={3} className="size-3.5" />}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="h-fit">
          <div className="flex items-start gap-3 px-5 pt-5 pb-4">
            <span aria-hidden className="flex size-9 items-center justify-center rounded-md bg-brand-50 text-brand-600">
              <Shield className="size-5" />
            </span>
            <div className="flex flex-col">
              <h2 className="text-body-lg font-semibold text-text-primary">Security</h2>
              <p className="text-caption text-text-muted">Applies to every platform staff account · set by the platform team</p>
            </div>
          </div>
          {meta ? (
            <dl className="flex flex-col divide-y divide-border-default px-5 pb-3">
              <SecurityRow label="Require 2FA" hint="Authenticator app for every staff member">
                <Toggle label="Require 2FA" checked={meta.security.totp_required} disabled />
              </SecurityRow>
              <SecurityRow label="IP allowlist" hint={meta.security.ip_allowlist_enabled ? 'Admin is reachable only from listed networks' : 'Not configured'}>
                <Toggle label="IP allowlist" checked={meta.security.ip_allowlist_enabled} disabled />
              </SecurityRow>
              <SecurityRow label="Session timeout" hint="Sign out after inactivity">
                <span className="text-body font-medium text-text-primary">{meta.security.session_idle_minutes} minutes</span>
              </SecurityRow>
              <SecurityRow label="Max impersonation session" hint="Ends automatically, read-only">
                <span className="text-body font-medium text-text-primary">{meta.security.impersonation_minutes} min</span>
              </SecurityRow>
            </dl>
          ) : (
            <LoadingRows label="Loading security settings" rows={3} />
          )}
        </Card>
      </div>

      {invite && (
        <InviteDialog
          onClose={() => setInvite(false)}
          onInvited={(inv) => {
            setInvite(false);
            toast(`Invitation sent to ${inv.email}`);
            refresh();
          }}
        />
      )}
      {action && (
        <TeamActionDialog
          action={action}
          onClose={() => setAction(null)}
          onDone={(msg) => {
            setAction(null);
            toast(msg);
            refresh();
          }}
        />
      )}
    </>
  );
}

function SecurityRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <dt className="text-body font-medium text-text-primary">{label}</dt>
        <dd className="text-caption text-text-muted">{hint}</dd>
      </div>
      {children}
    </div>
  );
}

function TeamActionDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: (message: string) => void }) {
  const s = action.staff;
  const who = s.name ?? s.email;
  const [newRole, setNewRole] = useState<PlatformRole>(s.role);
  switch (action.kind) {
    case 'role':
      return (
        <ReasonDialog
          title={`Change ${who}’s role`}
          description="The new permissions apply on their next request."
          confirmLabel="Change role"
          onCancel={onClose}
          onSubmit={(reason) => api.admin.team.updateRole(s.id, { role: newRole, reason })}
          onDone={(u) => onDone(`${who} is now ${roleLabel[u.role]}`)}
        >
          <Select label="Role" value={newRole} onChange={(e) => setNewRole(e.target.value as PlatformRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </Select>
        </ReasonDialog>
      );
    case 'disable':
      return (
        <ReasonDialog
          title={`Disable ${who}?`}
          description="They are signed out of Platform admin and can’t sign in until re-enabled. Their merchant accounts are not affected."
          confirmLabel="Disable"
          tone="danger"
          onCancel={onClose}
          onSubmit={(reason) => api.admin.team.disable(s.id, reason)}
          onDone={() => onDone(`${who} disabled`)}
        />
      );
    case 'enable':
      return (
        <ReasonDialog
          title={`Enable ${who}?`}
          description="They can sign in to Platform admin again."
          confirmLabel="Enable"
          onCancel={onClose}
          onSubmit={(reason) => api.admin.team.enable(s.id, reason)}
          onDone={() => onDone(`${who} enabled`)}
        />
      );
    case 'reset':
      return (
        <ReasonDialog
          title={`Reset 2FA for ${who}?`}
          description="Their authenticator and recovery codes stop working. They set up 2FA again on their next sign-in."
          confirmLabel="Reset 2FA"
          tone="danger"
          onCancel={onClose}
          onSubmit={(reason) => api.admin.team.resetTotp(s.id, reason)}
          onDone={() => onDone(`2FA reset for ${who}`)}
        />
      );
    case 'revoke':
      return <RevokeInvitationDialog staff={s} onClose={onClose} onDone={() => onDone(`Invitation for ${s.email} revoked`)} />;
  }
}

function RevokeInvitationDialog({ staff, onClose, onDone }: { staff: PlatformStaff; onClose: () => void; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ReasonlessConfirm
      title={`Revoke the invitation for ${staff.email}?`}
      description="The invite link stops working right away."
      pending={pending}
      error={error}
      onCancel={onClose}
      onConfirm={async () => {
        setPending(true);
        setError(null);
        try {
          await api.admin.team.revokeInvitation(staff.id);
          onDone();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setPending(false);
        }
      }}
    />
  );
}

function ReasonlessConfirm({
  title,
  description,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      title={title}
      description={description}
      confirmLabel="Revoke invitation"
      tone="danger"
      loading={pending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {error ? (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
