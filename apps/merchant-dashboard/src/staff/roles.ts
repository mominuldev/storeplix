import type { PermissionDefinition, PermissionGroup, PermissionKey, Role, RolesMeta, StaffMember, TenantRole } from '@storeplix/types';
import { PERMISSION_KEYS } from '@storeplix/types';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can, holdsAll, type PermissionHolder } from '../lib/permissions';
import { showFeatureUpgrade } from '../plan/Banners';

// PHASE-8-3 §7: shared data + rules for the Staff page, role editor and invite modal.

export const roleKeys = {
  list: (tenantId: string | null) => ['roles', tenantId] as const,
  detail: (tenantId: string | null, id: string | undefined) => ['roles', tenantId, 'detail', id] as const,
  catalogue: (tenantId: string | null) => ['permissions', tenantId] as const,
};

export function useRoles(enabled = true) {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({ queryKey: roleKeys.list(tenantId), queryFn: () => api.roles.list(), enabled: enabled && !!tenantId && can.manageStaff(activeTenant), retry: false });
}

export function usePermissionCatalogue(enabled = true) {
  const { tenantId, activeTenant } = useAuth();
  return useQuery({
    queryKey: roleKeys.catalogue(tenantId),
    queryFn: () => api.permissions.list(),
    enabled: enabled && !!tenantId && can.manageStaff(activeTenant),
    retry: false,
    staleTime: 10 * 60_000,
  });
}

/** Figma pill styles: Owner brand, Manager info, Staff neutral; custom roles cycle "Order staff" (warning) / "Packer" (neutral). */
const systemPill: Record<Exclude<TenantRole, 'custom'>, string> = {
  owner: 'bg-brand-50 text-brand-700',
  admin: 'bg-info-bg text-info',
  staff: 'bg-surface-subtle text-text-secondary',
};
const customPills = ['bg-warning-bg text-warning', 'bg-surface-subtle text-text-secondary'] as const;

export function rolePillClass(kind: TenantRole, roleId: string | null | undefined, roles: readonly Role[] | undefined): string {
  if (kind !== 'custom') return systemPill[kind];
  const custom = (roles ?? []).filter((r) => !r.is_system);
  const i = custom.findIndex((r) => r.id === roleId);
  return customPills[Math.max(0, i) % customPills.length]!;
}

export const roleKind = (r: Pick<Role, 'key'>): TenantRole => r.key ?? 'custom';

/** Flattened catalogue in §2.1 order. */
export function flatCatalogue(groups: readonly PermissionGroup[] | undefined): PermissionDefinition[] {
  return (groups ?? []).flatMap((g) => g.permissions);
}

/** P83-11: ticking a key also ticks everything it (transitively) requires. */
export function withPrerequisites(set: ReadonlySet<PermissionKey>, key: PermissionKey, defs: readonly PermissionDefinition[]): Set<PermissionKey> {
  const next = new Set(set);
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    if (next.has(k) && k !== key) continue;
    next.add(k);
    for (const r of defs.find((d) => d.key === k)?.requires ?? []) if (!next.has(r)) stack.push(r);
  }
  return next;
}

/** P83-11: unticking a key also unticks everything that (transitively) requires it. */
export function withoutDependents(set: ReadonlySet<PermissionKey>, key: PermissionKey, defs: readonly PermissionDefinition[]): Set<PermissionKey> {
  const next = new Set(set);
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    if (!next.delete(k)) continue;
    for (const d of defs) if (d.requires.includes(k) && next.has(d.key)) stack.push(d.key);
  }
  return next;
}

export const toggled = (set: ReadonlySet<PermissionKey>, key: PermissionKey, on: boolean, defs: readonly PermissionDefinition[]) =>
  on ? withPrerequisites(set, key, defs) : withoutDependents(set, key, defs);

/** Keys in catalogue order (stable payloads and comparisons). */
export const sortedKeys = (set: Iterable<PermissionKey>): PermissionKey[] => {
  const s = new Set(set);
  return PERMISSION_KEYS.filter((k) => s.has(k));
};

export const sameKeys = (a: Iterable<PermissionKey>, b: Iterable<PermissionKey>) => sortedKeys(a).join() === sortedKeys(b).join();

/**
 * Roles the actor may assign (N5): never the owner role, every key held; custom roles only with `custom_roles` (N9).
 * Order: Manager, Staff, then custom roles (as listed by the API).
 */
export function assignableRoles(me: PermissionHolder, roles: readonly Role[] | undefined, customEnabled: boolean) {
  return (roles ?? [])
    .filter((r) => r.key !== 'owner' && (r.is_system || customEnabled))
    .map((r) => ({ role: r, allowed: can.assignRole(me, r) }));
}

/** Why the actor can't assign a role (shown next to a disabled option). */
export const notAssignableReason = (me: PermissionHolder, r: Role) => (holdsAll(me, r.permissions) ? null : 'Has permissions you don’t have');

export const peopleCount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Members (not invitations) whose role the actor may change to `target` (N5/N6/N7). */
export function assignCandidates(me: PermissionHolder, staff: readonly StaffMember[], target: Role, roles: readonly Role[] | undefined) {
  return staff.filter((m) => m.role_id !== target.id && can.changeRole(me, m, roles));
}

export const CUSTOM_ROLES_UPGRADE = 'Custom roles like Order staff and Packer are part of the Growth plan.';
export const CUSTOM_ROLES_UPGRADE_TITLE = 'Custom roles are on Growth';

/** "+ Custom role" / "Duplicate role": the editor, or the Phase 7 upgrade prompt without `custom_roles` (§7.2). */
export function useNewRole() {
  const navigate = useNavigate();
  return (meta: Pick<RolesMeta, 'custom_roles_enabled'> | undefined, from?: string) => {
    if (!meta?.custom_roles_enabled) return showFeatureUpgrade(CUSTOM_ROLES_UPGRADE_TITLE, CUSTOM_ROLES_UPGRADE, 'growth');
    navigate(from ? `/staff/roles/new?from=${encodeURIComponent(from)}` : '/staff/roles/new');
  };
}
