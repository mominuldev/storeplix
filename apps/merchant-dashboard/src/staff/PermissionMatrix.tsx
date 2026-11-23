import { isApiError } from '@storeplix/api-client';
import type { PermissionKey, Role, RolesMeta } from '@storeplix/types';
import { Badge, Button, Card, cn, DraftBar, DraftBarGhostButton, Spinner } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Shield } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock } from '../catalog/states';
import { api } from '../lib/api';
import { hasPermission } from '../lib/permissions';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { flatCatalogue, sameKeys, sortedKeys, toggled, usePermissionCatalogue } from './roles';

type Staged = Record<string, Set<PermissionKey>>;

// Figma Card / Roles & permissions 63:16333 — p 24, gap 16; matrix: 1px border radius 12, header surface-subtle
// Caption/12 Medium muted uppercase, rows px 16 py 12 border-t; permission Body/14 Medium + Caption/12 hint; 96px
// role columns with 20px checkboxes (owner/system disabled at 50%); sensitive rows warning-bg with a "Sensitive" tag.
// PHASE-8-3 §7.2: rows grouped by PermissionGroup (sub-header rows); custom columns with `editable` are live and
// stage changes behind the Unsaved changes bar (one PATCH per changed role); horizontal scroll past 5 roles.
// Phones (Q125, P83-QA-1): below `sm` the sticky permission column is 136 px with wrapping labels (description hidden)
// and role columns are 80 px, so role checkboxes stay reachable beside it; group sub-headers keep their label pinned
// by a sticky inner span (a sticky colSpan cell is as wide as the table and scrolls away).
export function PermissionMatrix({
  roles,
  meta,
  rolesLoading,
  rolesError,
  onNew,
  onRetry,
}: {
  roles: Role[] | undefined;
  meta: RolesMeta | undefined;
  rolesLoading: boolean;
  rolesError: unknown;
  onNew: () => void;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const { activeTenant: me } = useAuth();
  const catalogue = usePermissionCatalogue();
  const defs = useMemo(() => flatCatalogue(catalogue.data), [catalogue.data]);
  const [staged, setStaged] = useState<Staged>({});
  const [lastChange, setLastChange] = useState<string | null>(null);
  const customEnabled = !!meta?.custom_roles_enabled;

  const columns = roles ?? [];
  const liveColumn = (r: Role) => !r.is_system && r.editable && customEnabled;
  const valueOf = (r: Role) => staged[r.id] ?? new Set(r.permissions);
  const changed = columns.filter((r) => staged[r.id] && !sameKeys(staged[r.id]!, r.permissions));
  const dirty = changed.length > 0;
  const leave = useLeaveGuard(dirty); // W-1: in-app links and "+ Custom role" ask before dropping staged changes

  const toggle = (r: Role, key: PermissionKey, on: boolean) => {
    setStaged((s) => ({ ...s, [r.id]: toggled(valueOf(r), key, on, defs) }));
    const label = defs.find((d) => d.key === key)?.label ?? key;
    setLastChange(`“${label}” turned ${on ? 'on' : 'off'} for ${r.name}`);
  };

  const save = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(changed.map((r) => api.roles.update(r.id, { revision: r.revision, permissions: sortedKeys(staged[r.id]!) })));
      return results.map((res, i) => ({ role: changed[i]!, res }));
    },
    onSuccess: async (outcomes) => {
      const failed = outcomes.filter((o) => o.res.status === 'rejected');
      const conflict = failed.some((o) => o.res.status === 'rejected' && isApiError(o.res.reason) && o.res.reason.code === 'revision_conflict');
      // Keep only the roles that failed for a reason other than a conflict (a conflict reloads the latest version).
      setStaged((s) => {
        const next: Staged = {};
        for (const o of failed) {
          const err = o.res.status === 'rejected' ? o.res.reason : null;
          if (!(isApiError(err) && err.code === 'revision_conflict') && s[o.role.id]) next[o.role.id] = s[o.role.id]!;
        }
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      if (conflict) toast('Someone else changed a role while you were editing. We loaded the latest version.', 'error');
      const other = failed.find((o) => !(o.res.status === 'rejected' && isApiError(o.res.reason) && o.res.reason.code === 'revision_conflict'));
      if (other && other.res.status === 'rejected') {
        if (!handlePlanLimit(other.res.reason)) toast(isApiError(other.res.reason) ? other.res.reason.message : `Couldn’t save ${other.role.name}.`, 'error');
      }
      if (!failed.length) {
        setLastChange(null);
        toast('Permissions saved. They apply from each person’s next action.');
      }
    },
  });

  const lockedCustom = columns.some((r) => !r.is_system) && !customEnabled;

  return (
    <Card className="flex flex-col gap-4 p-6" aria-label="Roles & permissions">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-body-lg font-medium text-text-primary">Roles & permissions</h2>
          <p className="text-body text-text-secondary">What each role can do. Owner always has full access. Tick a box to change a role for everyone who has it.</p>
        </div>
        <Button size="sm" variant="secondary" className="shrink-0 self-start" onClick={() => leave.guard(onNew)}>
          + Custom role
        </Button>
      </div>
      {lockedCustom && (
        <p className="flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-caption text-text-primary">
          <Shield aria-hidden className="size-4 shrink-0 text-brand-600" />
          Growth plan: editing custom roles needs the Growth plan. They keep working as they are; you can still move people to a built-in role or delete them.
        </p>
      )}
      {rolesLoading || catalogue.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner label="Loading permissions" />
        </div>
      ) : rolesError || catalogue.isError ? (
        <ErrorBlock
          error={rolesError ?? catalogue.error}
          title="Couldn’t load permissions"
          onRetry={() => {
            onRetry();
            void catalogue.refetch();
          }}
        />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-border-default">
          <table
            className="w-full min-w-(--matrix-min) text-left sm:min-w-(--matrix-min-sm)"
            style={{ '--matrix-min': `${136 + columns.length * 80}px`, '--matrix-min-sm': `${320 + columns.length * 96}px` } as CSSProperties}
          >
            <thead className="bg-surface-subtle text-caption font-medium text-text-muted uppercase">
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-34 bg-surface-subtle py-2.5 pr-2 pl-3 font-medium sm:w-80 sm:pl-4">
                  Permission
                </th>
                {columns.map((r) => (
                  <th key={r.id} scope="col" className="w-20 px-1 py-2.5 text-center font-medium break-words sm:w-24 sm:px-2">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            {(catalogue.data ?? []).map((g) => (
              <tbody key={g.key}>
                <tr className="border-t border-border-default">
                  <th scope="rowgroup" colSpan={columns.length + 1} className="bg-surface-card pt-3 pb-1 text-left text-caption font-medium text-text-muted uppercase">
                    <span className="sticky left-0 inline-block px-3 sm:px-4">{g.label}</span>
                  </th>
                </tr>
                {g.permissions.map((p) => (
                  <tr key={p.key} className={cn('border-t border-border-default', p.sensitive && 'bg-warning-bg')}>
                    <th
                      scope="row"
                      className={cn('sticky left-0 z-10 w-34 py-3 pr-2 pl-3 text-left font-normal break-words sm:w-80 sm:pl-4', p.sensitive ? 'bg-warning-bg' : 'bg-surface-card')}
                    >
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-caption font-medium text-text-primary sm:text-body">{p.label}</span>
                        {p.sensitive && (
                          <Badge tone="warning" size="sm">
                            Sensitive
                          </Badge>
                        )}
                      </span>
                      {p.description && <span className="mt-0.5 hidden text-caption text-text-secondary sm:block">{p.description}</span>}
                    </th>
                    {columns.map((r) => {
                      const on = valueOf(r).has(p.key);
                      const live = liveColumn(r) && p.grantable && hasPermission(me, p.key);
                      return (
                        <td key={r.id} className="px-1 py-3 text-center sm:px-2">
                          <MatrixBox
                            checked={on}
                            disabled={!live}
                            muted={r.key === 'owner'}
                            label={`${r.name}: ${p.label}`}
                            title={liveColumn(r) && !live ? (p.grantable ? 'You don’t have this permission' : 'Owner only') : undefined}
                            onChange={(v) => toggle(r, p.key, v)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {catalogue.data?.some((g) => g.permissions.some((p) => p.key === 'costs.view')) && (
        <p className="flex items-start gap-2 text-caption text-text-secondary">
          <Shield aria-hidden className="size-4 shrink-0 text-text-muted" />
          When cost & profit is off, that role sees selling prices only — cost columns, margin and the profit card on the dashboard are hidden.
        </p>
      )}
      {leave.dialog}
      {dirty && (
        <DraftBar
          title="Unsaved changes"
          description={lastChange ?? `${changed.length} ${changed.length === 1 ? 'role' : 'roles'} changed`}
          actions={
            <>
              <DraftBarGhostButton
                onClick={() => {
                  setStaged({});
                  setLastChange(null);
                }}
                disabled={save.isPending}
              >
                Discard
              </DraftBarGhostButton>
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save changes
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}

/** Figma Checkbox 31:6638 at 20px, radius 6: on = brand-600 + white check; off = 1.5px border-strong; owner column 50%. */
function MatrixBox({ checked, disabled, muted, label, title, onChange }: { checked: boolean; disabled: boolean; muted: boolean; label: string; title?: string; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('relative inline-flex size-5 align-middle', disabled ? 'cursor-not-allowed' : 'cursor-pointer', muted && 'opacity-50')} title={title}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer size-5 cursor-[inherit] appearance-none rounded-[6px] border-[1.5px] border-border-strong bg-surface-card outline-none checked:border-brand-600 checked:bg-brand-600 focus-visible:shadow-focus"
      />
      <Check aria-hidden strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto size-3.5 text-text-inverse opacity-0 peer-checked:opacity-100" />
    </label>
  );
}
