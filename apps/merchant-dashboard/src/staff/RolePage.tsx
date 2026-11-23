import { isApiError } from '@storeplix/api-client';
import type { PermissionDefinition, PermissionKey, Role, RoleDetail, StaffMember } from '@storeplix/types';
import { Avatar, Badge, Button, buttonVariants, Card, cn, Dialog, DraftBar, DraftBarGhostButton, Input, Modal, Select, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Info, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { NoAccessState } from '../layout/RequirePermission';
import { api } from '../lib/api';
import { can, hasPermission, holdsAll } from '../lib/permissions';
import { formatBdPhone } from '../lib/phone';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { assignableRoles, assignCandidates, CUSTOM_ROLES_UPGRADE, useNewRole, flatCatalogue, peopleCount, roleKeys, sameKeys, sortedKeys, toggled, usePermissionCatalogue, useRoles } from './roles';

interface Draft {
  name: string;
  description: string;
  permissions: Set<PermissionKey>;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Figma "When off: …" hints for sensitive keys (90:27613). */
const offHint: Partial<Record<PermissionKey, string>> = {
  'costs.view': 'When off: cost columns, margin and the profit card are hidden for this role.',
};

// Figma Role detail 90:26913 · Main 90:26915 — breadcrumb, header (Duplicate role / Save role), left column 360
// (Role details, People with this role, + Delete role), right column = one card per permission group with toggle
// rows (sensitive keys in the warning block with a "Sensitive" tag), Unsaved changes bar at the bottom.
// Not built: Warehouse access (Q119), "Change price on an order" / "Delete orders" rows (Q115). Stacks below lg (Q125).
export default function RolePage() {
  const { roleId } = useParams();
  const [params] = useSearchParams();
  const isNew = !roleId;
  const fromId = isNew ? params.get('from') : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeTenant: me, tenantId } = useAuth();
  const manage = can.manageStaff(me);
  const newRole = useNewRole();

  const roles = useRoles(manage);
  const catalogue = usePermissionCatalogue(manage);
  const sourceId = roleId ?? fromId ?? undefined;
  const detail = useQuery({
    queryKey: roleKeys.detail(tenantId, sourceId),
    queryFn: () => api.roles.get(sourceId!),
    enabled: manage && !!sourceId,
    retry: false,
  });
  const defs = useMemo(() => flatCatalogue(catalogue.data), [catalogue.data]);
  const meta = roles.data?.meta;
  const customEnabled = !!meta?.custom_roles_enabled;

  const base: RoleDetail | null = !isNew ? (detail.data ?? null) : null;
  // Seed the form once per server version (id + revision), never on unrelated re-renders (e.g. /auth/me refetch).
  const seedKey = isNew
    ? fromId
      ? detail.data
        ? `from:${detail.data.id}:${defs.length}`
        : null
      : `new:${defs.length}`
    : detail.data
      ? `${detail.data.id}:${detail.data.revision}`
      : null;
  const [seeded, setSeeded] = useState<{ key: string; initial: Draft } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [lastChange, setLastChange] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  if (seedKey && seeded?.key !== seedKey) {
    const src = detail.data;
    let next: Draft;
    if (isNew) {
      // Duplicate: copy only keys the actor may grant (N1).
      const keys = (src?.permissions ?? []).filter((k) => hasPermission(me, k) && defs.find((d) => d.key === k)?.grantable !== false);
      next = { name: src ? `${src.name} copy`.slice(0, 40) : '', description: src?.description ?? '', permissions: new Set(keys) };
    } else {
      next = { name: src!.name, description: src!.description ?? '', permissions: new Set(src!.permissions) };
    }
    setSeeded({ key: seedKey, initial: next });
    setDraft(next);
    setLastChange(null);
  }
  const initial = seeded?.initial ?? null;

  const dirty = !!draft && !!initial && (isNew || draft.name !== initial.name || draft.description !== initial.description || !sameKeys(draft.permissions, initial.permissions));

  // Route-leave guard (W-1): browser leave + in-app links + Duplicate, only once something was actually edited.
  const edited = !!draft && !!initial && (draft.name !== initial.name || draft.description !== initial.description || !sameKeys(draft.permissions, initial.permissions));
  const leave = useLeaveGuard(edited);

  const ownRole = !!base && base.id === me?.role_id;
  const readOnlyReason: string | null = isNew
    ? null
    : !base
      ? null
      : base.is_system
        ? 'Built-in role. Duplicate it to customise.'
        : ownRole
          ? 'You can’t edit your own role.'
          : !customEnabled
            ? `${CUSTOM_ROLES_UPGRADE} You can still view it, move people to another role or delete it.`
            : !base.editable
              ? 'This role has permissions you don’t have, so you can’t change it.'
              : null;
  const readOnly = !!readOnlyReason;
  const canDelete = !!base && !base.is_system && !ownRole && holdsAll(me, base.permissions);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const permissions = sortedKeys(d.permissions);
      const description = d.description.trim() || null;
      if (isNew) return api.roles.create({ name: d.name.trim(), description, permissions });
      const input: Parameters<typeof api.roles.update>[1] = { revision: base!.revision };
      if (d.name.trim() !== base!.name) input.name = d.name.trim();
      if (description !== (base!.description ?? null)) input.description = description;
      if (!sameKeys(d.permissions, base!.permissions)) input.permissions = permissions;
      return api.roles.update(base!.id, input);
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(roleKeys.detail(tenantId, saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast(isNew ? `${saved.name} created.` : 'Role saved. Changes apply from each person’s next action.');
      if (isNew) navigate(`/staff/roles/${saved.id}`, { replace: true });
    },
    onError: async (e) => {
      setFormError(null);
      if (handlePlanLimit(e)) return;
      if (isApiError(e) && e.code === 'revision_conflict') {
        toast('Someone else changed this role while you were editing. We loaded the latest version.', 'error');
        await detail.refetch();
        return;
      }
      if (isApiError(e) && e.isValidation) {
        const msg = e.fieldError('name');
        if (msg) setNameError(msg);
        const other = e.fieldError('permissions') ?? e.fieldError('description');
        if (other || !msg) setFormError(other ?? e.message);
        return;
      }
      if (isApiError(e) && e.code === 'role_limit_reached') return setFormError(`You’ve reached ${meta?.custom_roles_limit ?? 20} custom roles. Delete one to add another.`);
      setFormError(isApiError(e) ? e.message : 'Could not save the role.');
    },
  });

  if (!manage) return <NoAccessState heading="Staff" title="You can’t manage staff" description="Ask your shop owner if you need someone added or your role changed." />;

  const breadcrumb = (name: string) => (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-caption">
      <Link to="/staff" className="text-brand-600 hover:underline">
        Staff
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <Link to="/staff" className="text-brand-600 hover:underline">
        Roles
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <span className="font-medium text-text-primary">{name}</span>
    </nav>
  );

  // 404 / error / loading (States 148:34032).
  if (!isNew && detail.isError) {
    if (isApiError(detail.error) && detail.error.status === 404) {
      return (
        <div className="flex flex-col gap-6">
          {breadcrumb('Not found')}
          <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-secondary [&_svg]:size-6">
                <Search aria-hidden />
              </span>
              <h1 className="text-body-lg font-medium text-text-primary">This role doesn’t exist</h1>
              <p className="max-w-sm text-body text-text-secondary">It may have been deleted. Go back to Staff to see the current roles.</p>
              <Link to="/staff" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
                Back to Staff
              </Link>
            </div>
          </section>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb('Role')}
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <ErrorBlock error={detail.error} title="We couldn’t load this role" onRetry={() => void detail.refetch()} />
        </section>
      </div>
    );
  }
  if (catalogue.isError || roles.isError) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb(isNew ? 'New role' : 'Role')}
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <ErrorBlock
            error={catalogue.error ?? roles.error}
            title="We couldn’t load permissions"
            onRetry={() => {
              void catalogue.refetch();
              void roles.refetch();
            }}
          />
        </section>
      </div>
    );
  }

  // Creating without `custom_roles` → the upgrade prompt instead of the editor (§7.2).
  if (isNew && meta && !customEnabled) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb('New role')}
        <section aria-label="Upgrade for custom roles" className="flex flex-col items-start gap-3 rounded-card border border-brand-100 bg-brand-50 p-6 sm:flex-row sm:items-center">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-card text-brand-600">
            <Lock aria-hidden className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1 className="text-body-lg font-medium text-text-primary">Create roles that fit your team</h1>
            <p className="text-body text-text-secondary">{CUSTOM_ROLES_UPGRADE} Owner, Manager and Staff stay available on every plan.</p>
          </div>
          {can.manageBilling(me) ? (
            <Link to="/settings/plan?upgrade=growth" className={buttonVariants({ size: 'md' })}>
              Upgrade to Growth
            </Link>
          ) : (
            <span className="text-caption text-text-secondary">Ask your shop owner to upgrade.</span>
          )}
        </section>
      </div>
    );
  }
  if (isNew && meta && meta.custom_roles_used >= meta.custom_roles_limit) {
    return (
      <div className="flex flex-col gap-6">
        {breadcrumb('New role')}
        <NoAccessState title={`You’ve reached ${meta.custom_roles_limit} custom roles`} description="Delete a role you no longer use to add another." />
      </div>
    );
  }

  if (!draft || catalogue.isPending || roles.isPending || (!!sourceId && detail.isPending)) {
    return (
      <div className="flex flex-col gap-6" aria-busy>
        {breadcrumb(isNew ? 'New role' : 'Role')}
        <section className="rounded-card border border-border-default bg-surface-card p-2 shadow-elevation-1">
          <LoadingRows rows={6} label="Loading role" />
        </section>
      </div>
    );
  }

  const title = isNew ? draft.name.trim() || 'New role' : base!.name;
  const subtitle = isNew
    ? fromId && detail.data
      ? `New role · copied from ${detail.data.name}`
      : 'New role · pick what people with this role can see and do'
    : `${base!.is_system ? 'Built-in role' : 'Role'} · ${peopleCount(base!.members_count)}${base!.updated_by ? ` · edited ${fmtDate(base!.updated_at)} by ${base!.updated_by.name}` : ''}`;

  const setPerm = (p: PermissionDefinition, on: boolean) => {
    setDraft((d) => (d ? { ...d, permissions: toggled(d.permissions, p.key, on, defs) } : d));
    setLastChange(`“${p.label}” turned ${on ? 'on' : 'off'} for ${draft.name.trim() || 'this role'}`);
  };
  const discard = () => {
    setDraft(initial);
    setLastChange(null);
    setNameError(null);
    setFormError(null);
  };
  const submit = () => {
    setNameError(null);
    setFormError(null);
    const name = draft.name.trim();
    if (!name) return setNameError('Give the role a name.');
    if (name.length > 40) return setNameError('Use 40 characters or fewer.');
    save.mutate(draft);
  };

  return (
    <div className="flex flex-col gap-6">
      {breadcrumb(title)}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate text-heading-24 text-text-primary">{title}</h1>
          <p className="text-body text-text-secondary">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!isNew && (
            <Button variant="secondary" onClick={() => leave.guard(() => newRole(meta, base!.id))}>
              Duplicate role
            </Button>
          )}
          {!readOnly && (
            <Button loading={save.isPending} disabled={!dirty} onClick={submit}>
              Save role
            </Button>
          )}
        </div>
      </div>

      {readOnlyReason && (
        <p role="note" className="flex items-start gap-2 rounded-lg bg-info-bg px-3.5 py-2.5 text-body text-text-primary">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
          {readOnlyReason}
        </p>
      )}
      {formError && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3.5 py-2.5 text-body text-danger">
          {formError}
        </p>
      )}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex w-full shrink-0 flex-col gap-6 lg:w-[360px]">
          <Card className="flex flex-col gap-4 p-6" aria-label="Role details">
            <h2 className="text-body-lg font-medium text-text-primary">Role details</h2>
            <Input
              label="Role name"
              value={draft.name}
              maxLength={40}
              disabled={readOnly}
              error={nameError ?? undefined}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
                setLastChange('Role name changed');
              }}
            />
            <Input
              label="Description"
              value={draft.description}
              maxLength={200}
              disabled={readOnly}
              placeholder="What this role is for"
              onChange={(e) => {
                setDraft({ ...draft, description: e.target.value });
                setLastChange('Description changed');
              }}
            />
          </Card>

          {!isNew && base && <PeopleCard role={base} canAssign={!readOnly || (base.is_system && can.assignRole(me, base))} onAssign={() => setAssigning(true)} />}

          {canDelete && (
            <button type="button" className="self-start rounded-md px-1 text-body font-semibold text-danger outline-none hover:underline focus-visible:shadow-focus" onClick={() => setDeleting(true)}>
              Delete role
            </button>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {(catalogue.data ?? []).map((g) => (
            <Card key={g.key} className="flex flex-col gap-2 p-6" aria-label={g.label}>
              <h2 className="text-body-lg font-medium text-text-primary">{g.label}</h2>
              {g.permissions.map((p) => (
                <PermissionRow
                  key={p.key}
                  def={p}
                  checked={draft.permissions.has(p.key)}
                  disabledReason={readOnly ? 'locked' : !p.grantable ? 'Only the owner can have this' : !hasPermission(me, p.key) ? 'You don’t have this permission' : null}
                  onChange={(on) => setPerm(p, on)}
                />
              ))}
            </Card>
          ))}
        </div>
      </div>

      {dirty && !readOnly && (
        <DraftBar
          title={isNew ? 'New role' : 'Unsaved changes'}
          description={lastChange ?? (isNew ? 'Not saved yet' : undefined)}
          actions={
            <>
              <DraftBarGhostButton onClick={isNew ? () => navigate('/staff') : discard} disabled={save.isPending}>
                Discard
              </DraftBarGhostButton>
              <Button loading={save.isPending} onClick={submit}>
                {isNew ? 'Create role' : 'Save changes'}
              </Button>
            </>
          }
        />
      )}

      {leave.dialog}
      {deleting && base && <DeleteRoleDialog role={base} roles={roles.data?.data ?? []} customEnabled={customEnabled} onClose={() => setDeleting(false)} />}
      {assigning && base && <AssignDialog role={base} roles={roles.data?.data ?? []} onClose={() => setAssigning(false)} />}
    </div>
  );
}

// Figma Settings / Toggle row 60:11321 (h 40, py 6 wrapper; Body/14 Medium + Body/14 text-secondary) and the
// sensitive block 90:27602 (warning-bg, radius 12, px 14 py 12, "Sensitive" tag + Caption/12 hint).
function PermissionRow({ def: p, checked, disabledReason, onChange }: { def: PermissionDefinition; checked: boolean; disabledReason: string | null; onChange: (on: boolean) => void }) {
  const tip = disabledReason && disabledReason !== 'locked' ? disabledReason : undefined;
  const row = (
    <div className="flex min-h-10 items-center gap-4" title={tip}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-body">
        <span className="font-medium text-text-primary">{p.label}</span>
        {p.description && <span className="text-text-secondary">{p.description}</span>}
        {tip && <span className="text-caption text-text-muted">{tip}</span>}
      </div>
      <Toggle label={p.label} checked={checked} disabled={!!disabledReason} onChange={onChange} />
    </div>
  );
  if (!p.sensitive) return <div className="py-1.5">{row}</div>;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-warning-bg px-3.5 py-3">
      {row}
      <div className="flex items-center gap-2">
        <Badge tone="warning" size="sm">
          Sensitive
        </Badge>
        {offHint[p.key] && <span className="text-caption text-text-secondary">{offHint[p.key]}</span>}
      </div>
    </div>
  );
}

// Figma Card / People with this role 90:27521 — header + "+ Assign" ghost sm; rows: 32px avatar, name Body/14
// Semibold, phone Caption/12 text-secondary, Active (success) / Invited (warning) tag.
function PeopleCard({ role, canAssign, onAssign }: { role: RoleDetail; canAssign: boolean; onAssign: () => void }) {
  return (
    <Card className="flex flex-col gap-3 p-6" aria-label="People with this role">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-body-lg font-medium text-text-primary">People with this role</h2>
        {canAssign && role.key !== 'owner' && (
          <Button size="sm" variant="ghost" onClick={onAssign}>
            + Assign
          </Button>
        )}
      </div>
      {role.members.length === 0 ? (
        <p className="text-body text-text-muted">No one has this role yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {role.members.map((m) => (
            <li key={`${m.kind}-${m.id}`} className="flex items-center gap-2.5">
              <Avatar name={m.name ?? m.email} size="sm" className={m.kind === 'invitation' ? 'bg-surface-subtle text-text-muted' : undefined} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text-primary">
                  {m.name ?? m.email}
                  {m.is_you && ' (you)'}
                </span>
                <span className="truncate text-caption text-text-secondary">{m.phone ? formatBdPhone(m.phone) : m.email}</span>
              </span>
              <Badge size="sm" tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'warning' : 'danger'}>
                {m.status === 'active' ? 'Active' : m.status === 'invited' ? 'Invited' : 'Expired'}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "+ Assign": members whose role the actor may change to this role (N5/N6/N7) → PATCH /staff/{member}. */
function AssignDialog({ role, roles, onClose }: { role: RoleDetail; roles: Role[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { activeTenant: me, tenantId } = useAuth();
  const staff = useQuery({ queryKey: ['staff', tenantId], queryFn: () => api.staff.list(), retry: false });
  const candidates = assignCandidates(me, staff.data?.data ?? [], role, roles);
  const [picked, setPicked] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const assign = useMutation({
    mutationFn: (m: StaffMember) => api.staff.updateRole(m.id, { role_id: role.id }),
    onSuccess: async (_d, m) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['staff'] })]);
      toast(`${m.name ?? m.email} is now ${role.name}.`);
      onClose();
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return onClose();
      setError(isApiError(e) ? e.message : 'Could not assign the role.');
    },
  });
  const chosen = candidates.find((m) => m.id === picked);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign ${role.name}`}
      description="Pick a team member. The new role applies from their next action."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={assign.isPending} disabled={!chosen} onClick={() => chosen && assign.mutate(chosen)}>
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3.5 py-2.5 text-body text-danger">
            {error}
          </p>
        )}
        {staff.isPending ? (
          <LoadingRows rows={3} label="Loading team" />
        ) : staff.isError ? (
          <ErrorBlock error={staff.error} title="Couldn’t load your team" onRetry={() => void staff.refetch()} />
        ) : candidates.length === 0 ? (
          <p className="text-body text-text-secondary">There’s no one you can move to this role. Invite someone from the Staff page instead.</p>
        ) : (
          <Select label="Team member" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a person</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? m.email} · {m.role_name}
              </option>
            ))}
          </Select>
        )}
      </div>
    </Modal>
  );
}

/** §7.3 Delete role: confirm; when people use it a required "Move people to" select → DELETE ?reassign_to=. */
function DeleteRoleDialog({ role, roles, customEnabled, onClose }: { role: RoleDetail; roles: Role[]; customEnabled: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeTenant: me } = useAuth();
  const [inUse, setInUse] = useState(role.members_count + role.invitations_count > 0);
  const targets = assignableRoles(me, roles, customEnabled).filter((o) => o.allowed && o.role.id !== role.id);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.roles.remove(role.id, { revision: role.revision, reassign_to: inUse ? target : undefined }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['staff'] })]);
      toast(`${role.name} deleted.`);
      navigate('/staff');
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return;
      if (isApiError(e) && e.code === 'role_in_use') {
        setInUse(true);
        return setError('People were given this role in the meantime. Choose where to move them.');
      }
      if (isApiError(e) && e.code === 'revision_conflict') {
        void queryClient.invalidateQueries({ queryKey: ['roles'] });
        return setError('Someone else changed this role while you were looking. We loaded the latest version — check it, then delete again.');
      }
      setError(isApiError(e) ? (e.fieldError('reassign_to') ?? e.message) : 'Could not delete the role.');
    },
  });
  const count = role.members_count + role.invitations_count;
  return (
    <Dialog
      open
      tone="danger"
      title={`Delete ${role.name}?`}
      description={inUse ? `${peopleCount(count)} ${count === 1 ? 'has' : 'have'} this role. Move them to another role first — it applies from their next action.` : 'No one has this role. This can’t be undone.'}
      confirmLabel="Delete role"
      confirmDisabled={inUse && !target}
      loading={remove.isPending}
      onConfirm={() => remove.mutate()}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-3">
        {inUse && (
          <Select label="Move people to" value={target} onChange={(e) => setTarget(e.target.value)} required>
            <option value="">Choose a role</option>
            {targets.map(({ role: r }) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
        {error && (
          <p role="alert" className={cn('text-body text-danger')}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
